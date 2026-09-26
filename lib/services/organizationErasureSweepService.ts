import { randomUUID } from 'node:crypto';
import type { OrganizationErasureStep } from '@/generated/prisma/client';
import { markOrgClosing, offboardOrg } from '@/lib/ai/motirAiClient';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationDeletionRequestRepository } from '@/lib/repositories/organizationDeletionRequestRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import {
  organizationDeletionNotifier,
  type NoticeRecipient,
} from '@/lib/services/organizationDeletionNotifier';
import { organizationGitOffboardingService } from '@/lib/services/organizationGitOffboardingService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ORGANIZATION ERASURE SWEEP (Story MOTIR-6306 · MOTIR-6400;
// `docs/decisions/organization-deletion.md` §6). At the due date a scheduled
// deletion is carried out, in a FIXED order, recording progress on the request
// row after each step so an interrupted run resumes where it stopped:
//
//   git        — `organizationGitOffboardingService.offboardGit`. FIRST, because
//                `github_repo` / `github_installation` cascade on `workspace_id`:
//                erasing the workspaces first would destroy the list this walks.
//   workspaces — every workspace through `deleteWorkspaceCascade`, the ONE delete,
//                via its organization-erasure entry. Its two survivals come with
//                it: the code-graph offboarding row and the hostname reservation.
//                The meters (`CiPeriodUsage`, `CiWorkflowRunUsage`, the
//                `CiContainer*` rows) cascade away here, as §7 decides.
//   ai         — motir-ai offboards the tenant to its billing tombstone. BEFORE
//                ours, so the org id still resolves there.
//   tombstone  — one transaction: capture the Owner and Admins for the erased
//                notice, remove every membership, scrub the org (erased label,
//                random slug, flags reset, `erasedAt`), and mark the request
//                `erased`. NO slug reservation (§6): the org slug routes nothing.
//
// Content first, identity last. A crash before the tombstone leaves a closing org
// that is still named and still recoverable by support; a crash after it leaves
// nothing that needed recovering.
//
// ── THE CLAIM, AND THE CANCEL IT RACES ────────────────────────────────────────
// `scheduled → erasing` happens under the request row's lock (the repository's
// `findOpenByOrganizationIdForUpdate`, whose predicate is the org alone, so a
// loser reads the winner's status rather than zero rows). The cancel takes the
// same lock and refuses anything but `scheduled`. So a cancel that commits first
// leaves nothing to claim, and a cancel after the claim is refused — never both.
//
// ── A FAILURE STOPS ONE ORG, NEVER THE RUN ────────────────────────────────────
// A step that throws records `lastError` on the request and leaves `erasureStep`
// at the last step that finished. The request stays `erasing`, which `listDue`
// always returns, so the next run resumes it. Every step is idempotent on its
// own (the Git offboarding and motir-ai's offboard are; a deleted workspace is
// simply not listed again).
//
// ── THE RECONCILE ─────────────────────────────────────────────────────────────
// For every still-`scheduled` request, the closing call to motir-ai is re-sent:
// it is idempotent, and it repairs one that failed when the deletion was
// scheduled (MOTIR-6399 never un-schedules on that failure).
//
// SYSTEM context for the claim and the bookkeeping (the request table carries a
// system arm); the tombstone binds the org itself, because the `organization` and
// `organization_membership` write policies read `app.organization_id` only.

/** The name a tombstone carries — fixed, so it identifies nobody. */
export const ERASED_ORGANIZATION_NAME = 'Deleted organization';

/** The steps in order. `erasureStep` records the LAST one completed. */
export const ERASURE_STEPS: readonly OrganizationErasureStep[] = [
  'git',
  'workspaces',
  'ai',
  'tombstone',
];

/** How many requests one run considers; the rest are the next run's. */
const SWEEP_BATCH = 20;
/** How many scheduled requests one run re-sends the closing call for. */
const RECONCILE_BATCH = 200;
/** "Due by" far enough ahead to cover every scheduled request. */
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

export interface ErasureSweepDeps {
  offboardGit: (organizationId: string) => Promise<unknown>;
  deleteWorkspace: (input: {
    workspaceId: string;
    requestId: string;
    actorUserId: string;
  }) => Promise<void>;
  offboardAi: (organizationId: string) => Promise<unknown>;
  markClosing: (organizationId: string, dueAt: Date) => Promise<unknown>;
  notifyErased: typeof organizationDeletionNotifier.notifyErased;
}

const LIVE_DEPS: ErasureSweepDeps = {
  offboardGit: (id) => organizationGitOffboardingService.offboardGit(id),
  deleteWorkspace: (input) => workspacesService.deleteWorkspaceForOrganizationErasure(input),
  offboardAi: (id) => offboardOrg(id),
  markClosing: (id, dueAt) => markOrgClosing(id, dueAt),
  notifyErased: (input) => organizationDeletionNotifier.notifyErased(input),
};

export interface ErasureSweepSummary {
  scanned: number;
  claimed: number;
  resumed: number;
  erased: number;
  skipped: number;
  failed: number;
  failures: Array<{ requestId: string; step: string; error: string }>;
  reconciled: number;
}

/** A step's failure, carrying which step so it can be recorded. */
class ErasureStepError extends Error {
  constructor(
    readonly step: OrganizationErasureStep,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ErasureStepError';
  }
}

type Claim =
  | { kind: 'skip' }
  | {
      kind: 'run';
      resumed: boolean;
      organizationId: string;
      requestedByUserId: string | null;
      lastStep: OrganizationErasureStep | null;
    };

/** Lock the request and claim it — `scheduled` and due → `erasing`, or resume. */
async function claim(requestId: string, now: Date): Promise<Claim> {
  return withSystemContext(async (tx) => {
    const row = await organizationDeletionRequestRepository.findById(requestId, tx);
    if (!row) return { kind: 'skip' };
    const locked = await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
      row.organizationId,
      tx,
    );
    if (!locked || locked.id !== requestId) return { kind: 'skip' };
    const base = {
      organizationId: row.organizationId,
      requestedByUserId: row.requestedByUserId,
      lastStep: locked.erasureStep,
    };
    if (locked.status === 'erasing') return { kind: 'run', resumed: true, ...base };
    if (locked.status !== 'scheduled' || locked.erasureDueAt > now) return { kind: 'skip' };
    await organizationDeletionRequestRepository.update(
      requestId,
      { status: 'erasing', erasingStartedAt: now, lastError: null },
      tx,
    );
    return { kind: 'run', resumed: false, ...base };
  });
}

async function markStep(requestId: string, step: OrganizationErasureStep): Promise<void> {
  await withSystemContext((tx) =>
    organizationDeletionRequestRepository.update(
      requestId,
      { erasureStep: step, lastError: null },
      tx,
    ),
  );
}

async function run(step: OrganizationErasureStep, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new ErasureStepError(step, err);
  }
}

/** The tombstone, in one transaction bound to the org. Returns what the notice needs. */
async function writeTombstone(requestId: string, organizationId: string, now: Date) {
  return withOrgServiceWriteContext(organizationId, async (tx) => {
    const organization = await organizationRepository.findByIdInTx(organizationId, tx);
    const members = await organizationMembershipRepository.findMembersByOrg(organizationId, tx);
    const recipients: NoticeRecipient[] = members
      .filter((m) => (m.role === 'owner' || m.role === 'admin') && Boolean(m.user.email))
      .map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
    await organizationMembershipRepository.deleteAllByOrganization(organizationId, tx);
    await organizationRepository.scrubToTombstone(
      organizationId,
      { name: ERASED_ORGANIZATION_NAME, slug: `erased-${randomUUID()}`, erasedAt: now },
      tx,
    );
    await organizationDeletionRequestRepository.update(
      requestId,
      { status: 'erased', erasedAt: now, erasureStep: 'tombstone', lastError: null },
      tx,
    );
    return { organizationName: organization?.name ?? ERASED_ORGANIZATION_NAME, recipients };
  });
}

/** Erase one organization from the step after `lastStep`. Throws {@link ErasureStepError}. */
async function erase(
  requestId: string,
  c: Extract<Claim, { kind: 'run' }>,
  now: Date,
  deps: ErasureSweepDeps,
): Promise<void> {
  const done = c.lastStep === null ? -1 : ERASURE_STEPS.indexOf(c.lastStep);
  const todo = (step: OrganizationErasureStep) => ERASURE_STEPS.indexOf(step) > done;

  if (todo('git')) {
    await run('git', () => deps.offboardGit(c.organizationId));
    await markStep(requestId, 'git');
  }
  if (todo('workspaces')) {
    await run('workspaces', async () => {
      const workspaces = await withSystemContext((tx) =>
        workspaceRepository.listByOrganization(c.organizationId, tx),
      );
      // One transaction per workspace (inside the shared delete), so a crash
      // mid-loop leaves the deleted ones gone and the rest for the next run.
      for (const workspace of workspaces) {
        await deps.deleteWorkspace({
          workspaceId: workspace.id,
          requestId,
          actorUserId: c.requestedByUserId ?? '',
        });
      }
    });
    await markStep(requestId, 'workspaces');
  }
  if (todo('ai')) {
    await run('ai', () => deps.offboardAi(c.organizationId));
    await markStep(requestId, 'ai');
  }
  if (todo('tombstone')) {
    let notice: Awaited<ReturnType<typeof writeTombstone>> | null = null;
    await run('tombstone', async () => {
      notice = await writeTombstone(requestId, c.organizationId, now);
    });
    if (notice) {
      const { organizationName, recipients } = notice;
      await deps.notifyErased({ requestId, organizationName, erasedAt: now, recipients });
    }
  }
}

export const organizationErasureSweepService = {
  /**
   * Erase every due organization (at most {@link SWEEP_BATCH}), resuming any an
   * earlier run left `erasing`, then re-send the closing call for every
   * still-scheduled one. Returns the run's summary — the job ledger's record of a
   * per-org failure, which never fails the run.
   */
  async runDue(
    now: Date = new Date(),
    deps: ErasureSweepDeps = LIVE_DEPS,
    limit: number = SWEEP_BATCH,
  ): Promise<ErasureSweepSummary> {
    const summary: ErasureSweepSummary = {
      scanned: 0,
      claimed: 0,
      resumed: 0,
      erased: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      reconciled: 0,
    };

    const due = await withSystemContext((tx) =>
      organizationDeletionRequestRepository.listDue(now, limit, tx),
    );
    summary.scanned = due.length;
    for (const request of due) {
      const c = await claim(request.id, now);
      if (c.kind === 'skip') {
        summary.skipped += 1;
        continue;
      }
      if (c.resumed) summary.resumed += 1;
      else summary.claimed += 1;
      try {
        await erase(request.id, c, now, deps);
        summary.erased += 1;
      } catch (err) {
        const step = err instanceof ErasureStepError ? err.step : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        summary.failed += 1;
        summary.failures.push({ requestId: request.id, step, error: message });
        console.error('[organizationErasure] a step failed; the next run resumes it', {
          requestId: request.id,
          step,
          err,
        });
        await withSystemContext((tx) =>
          organizationDeletionRequestRepository.update(
            request.id,
            { lastError: `${step}: ${message}`.slice(0, 1000) },
            tx,
          ),
        );
      }
    }

    const scheduled = await withSystemContext((tx) =>
      organizationDeletionRequestRepository.listScheduledDueBy(FAR_FUTURE, RECONCILE_BATCH, tx),
    );
    for (const request of scheduled) {
      try {
        await deps.markClosing(request.organizationId, request.erasureDueAt);
        summary.reconciled += 1;
      } catch (err) {
        console.warn('[organizationErasure] closing reconcile failed; retried next run', {
          organizationId: request.organizationId,
          err,
        });
      }
    }
    return summary;
  },
};
