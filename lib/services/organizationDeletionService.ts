import { Prisma } from '@/generated/prisma/client';
import { markOrgClosing, reopenOrg } from '@/lib/ai/motirAiClient';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import type {
  OrganizationDeletionConsequencesDTO,
  OrganizationDeletionRequestDTO,
} from '@/lib/dto/organizationDeletion';
import { toOrganizationDeletionRequestDTO } from '@/lib/mappers/organizationDeletionMappers';
import { withOrgContext } from '@/lib/organizations/context';
import { erasureDueAt } from '@/lib/organizations/deletion';
import {
  OrganizationDeletionAlreadyScheduledError,
  OrganizationDeletionAlreadyStartedError,
  OrganizationNameMismatchError,
  OrganizationNotFoundError,
  StepUpFailedError,
} from '@/lib/organizations/errors';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { organizationDeletionRequestRepository } from '@/lib/repositories/organizationDeletionRequestRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertOrgCapability, assertOrgMember } from '@/lib/services/organizationAccessService';
import { organizationDeletionNotifier } from '@/lib/services/organizationDeletionNotifier';
import { usersService } from '@/lib/services/usersService';
import { withSystemContext } from '@/lib/workspaces/context';

// SCHEDULING AND CANCELLING AN ORGANIZATION'S DELETION (Story MOTIR-6306 ·
// MOTIR-6399; `docs/decisions/organization-deletion.md` §1–§4). The org-tier
// sibling of `accountDeletionService`, and shaped like it: one locked write per
// act, the three-outcome cancel, and every side effect AFTER the commit.
//
// ── WHO, AND HOW HARD (§1) ────────────────────────────────────────────────────
// Scheduling needs three proofs, all checked here on the server so that a
// scripted call without the dialog is refused exactly as the dialog would be:
//
//   1. the capability — `deleteOrganization`, the Owner alone;
//   2. the organization's EXACT current name, typed;
//   3. a FRESH step-up — the password for an account that has one; for an account
//      with none, a sign-in within the last {@link STEP_UP_WINDOW_MS}, read from
//      the session's own creation time. There is no passkey assertion: none
//      exists server-side to reuse, and a recent sign-in is the same proof.
//
// ── THE LOCK ORDER ────────────────────────────────────────────────────────────
// The ORGANIZATION ROW first (`lockByIdForUpdate`), then the latest request
// `FOR UPDATE`. Transfer takes the same org-row lock and refuses while closing,
// so a schedule and a transfer cannot interleave; the erasure sweep locks the
// request row, so a cancel racing it is decided by whichever commits first and
// the loser reads the winner's status (the repository's comment has the READ
// COMMITTED detail). The FIRST schedule of an org locks no request row; the
// partial unique index is the guard there, and its `P2002` is translated below.
//
// ── AFTER THE COMMIT, AND NEVER UNDOING IT ────────────────────────────────────
// motir-ai is told (`markOrgClosing` / `reopenOrg`) and every member is emailed.
// Both are best-effort: a failure is logged and the deletion stands. motir-ai's
// calls are idempotent, and the erasure sweep re-sends the closing call before it
// erases (its reconcile step), so a missed one converges.
//
// ── THE AUDIT RECORD ──────────────────────────────────────────────────────────
// There is no org-tier audit writer (`lib/activity/` is work-item activity;
// `platform_audit_log` records platform staff). The request row IS the audit
// entry, exactly as `account_deletion_request` is for accounts: who scheduled it
// and when (`requested_by_user_id`, `requested_at`), who cancelled it and when
// (`cancelled_by_user_id`, `cancelled_at`). Neither is ever rewritten.

/** How recent a passwordless account's sign-in must be to count as a step-up. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export interface ScheduleOrganizationDeletionInput {
  organizationId: string;
  actorUserId: string;
  confirmName: string;
  /** The Owner's password, when their account has one. */
  password?: string;
  /** When the acting session was created — the passwordless step-up's proof. */
  sessionSignedInAt: Date;
  now?: Date;
}

export type CancelOrganizationDeletionOutcome = 'cancelled' | 'none';

/** What the banner and the settings card read: the open request, and who opened it. */
export interface OrganizationDeletionStateDTO {
  request: OrganizationDeletionRequestDTO | null;
  scheduledByName: string | null;
}

function isOpen(status: string): boolean {
  return status === 'scheduled' || status === 'erasing';
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** The step-up (§1.3). Throws {@link StepUpFailedError}; returns nothing on success. */
async function assertStepUp(input: ScheduleOrganizationDeletionInput, now: Date): Promise<void> {
  const { hasPassword } = await usersService.getPasswordCapability(input.actorUserId);
  if (hasPassword) {
    const user = await userRepository.findById(input.actorUserId);
    const ok =
      Boolean(user?.email) &&
      typeof input.password === 'string' &&
      input.password.length > 0 &&
      (await usersService.verifyPassword(user!.email, input.password));
    if (!ok) throw new StepUpFailedError('wrong_password');
    return;
  }
  if (now.getTime() - input.sessionSignedInAt.getTime() > STEP_UP_WINDOW_MS) {
    throw new StepUpFailedError('reauth_required');
  }
}

async function afterCommit(what: string, organizationId: string, step: () => Promise<unknown>) {
  try {
    await step();
  } catch (err) {
    console.warn(`[organizationDeletion] ${what} failed after commit; the decision stands`, {
      organizationId,
      err,
    });
  }
}

export const organizationDeletionService = {
  /**
   * Schedule the organization's deletion. Returns the stored request — its
   * `erasureDueAt` is read from the row, never recomputed.
   *
   * Refusals, in order: a non-member → 404; an Admin or Member → 403; the wrong
   * name → 422; a failed step-up → 403 `STEP_UP_FAILED`; a deletion already open
   * (including one won by a concurrent schedule) → 409.
   */
  async scheduleOrganizationDeletion(
    input: ScheduleOrganizationDeletionInput,
  ): Promise<OrganizationDeletionRequestDTO> {
    const now = input.now ?? new Date();
    const scope = { userId: input.actorUserId, organizationId: input.organizationId };

    // 1 + 2 — capability and name, before the (slow) password hash is paid.
    await withOrgContext(scope, async (tx) => {
      await assertOrgCapability(input.actorUserId, input.organizationId, 'deleteOrganization', tx);
      const organization = await organizationRepository.findByIdInTx(input.organizationId, tx);
      if (!organization) throw new OrganizationNotFoundError(input.organizationId);
      if (input.confirmName !== organization.name) throw new OrganizationNameMismatchError();
    });

    // 3 — the fresh step-up.
    await assertStepUp(input, now);

    // The write: one transaction, the org row locked first.
    let created;
    try {
      created = await withOrgContext(scope, async (tx) => {
        await organizationRepository.lockByIdForUpdate(input.organizationId, tx);
        // Re-asserted under the lock: a transfer that committed meanwhile has
        // made the actor an Admin, and an Admin may not schedule.
        await assertOrgCapability(
          input.actorUserId,
          input.organizationId,
          'deleteOrganization',
          tx,
        );
        const latest =
          await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
            input.organizationId,
            tx,
          );
        if (latest && isOpen(latest.status)) {
          throw new OrganizationDeletionAlreadyScheduledError(input.organizationId);
        }
        const request = await organizationDeletionRequestRepository.create(
          {
            organizationId: input.organizationId,
            requestedByUserId: input.actorUserId,
            requestedAt: now,
            erasureDueAt: erasureDueAt(now),
          },
          tx,
        );
        await organizationRepository.update(input.organizationId, { closingSince: now }, tx);
        return request;
      });
    } catch (err) {
      // The partial unique index refused a second open request — the first
      // schedule of an org, raced, where there was no row yet to lock.
      if (isUniqueViolation(err)) {
        throw new OrganizationDeletionAlreadyScheduledError(input.organizationId);
      }
      throw err;
    }

    await afterCommit('motir-ai markOrgClosing', input.organizationId, () =>
      markOrgClosing(input.organizationId, created.erasureDueAt),
    );
    await organizationDeletionNotifier.notifyScheduled(created.id);
    return toOrganizationDeletionRequestDTO(created);
  },

  /**
   * Cancel a scheduled deletion — the Owner's. Three outcomes, decided under the
   * lock: `scheduled` → `cancelled` (the org reopens); `erasing` / `erased` /
   * `purged` → {@link OrganizationDeletionAlreadyStartedError}; nothing open →
   * `'none'`, a no-op.
   */
  async cancelOrganizationDeletion(input: {
    organizationId: string;
    actorUserId: string;
    now?: Date;
  }): Promise<{ outcome: CancelOrganizationDeletionOutcome; requestId: string | null }> {
    const now = input.now ?? new Date();
    const result = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgCapability(
          input.actorUserId,
          input.organizationId,
          'deleteOrganization',
          tx,
        );
        await organizationRepository.lockByIdForUpdate(input.organizationId, tx);
        const latest =
          await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
            input.organizationId,
            tx,
          );
        if (!latest || latest.status === 'cancelled') {
          return { outcome: 'none' as const, requestId: null };
        }
        if (latest.status !== 'scheduled') {
          throw new OrganizationDeletionAlreadyStartedError(input.organizationId);
        }
        await organizationDeletionRequestRepository.update(
          latest.id,
          { status: 'cancelled', cancelledAt: now, cancelledByUserId: input.actorUserId },
          tx,
        );
        await organizationRepository.update(input.organizationId, { closingSince: null }, tx);
        return { outcome: 'cancelled' as const, requestId: latest.id };
      },
    );

    if (result.outcome === 'cancelled' && result.requestId) {
      await afterCommit('motir-ai reopenOrg', input.organizationId, () =>
        reopenOrg(input.organizationId),
      );
      await organizationDeletionNotifier.notifyCancelled(result.requestId);
    }
    return result;
  },

  /**
   * The organization's open deletion, for any member — the banner and the
   * settings card render from it. `request: null` when nothing is open.
   */
  async getOrganizationDeletion(
    organizationId: string,
    actorUserId: string,
  ): Promise<OrganizationDeletionStateDTO> {
    return withOrgContext({ userId: actorUserId, organizationId }, async (tx) => {
      await assertOrgMember(actorUserId, organizationId, tx);
      const request = await organizationDeletionRequestRepository.findOpenByOrganizationId(
        organizationId,
        tx,
      );
      if (!request) return { request: null, scheduledByName: null };
      const scheduledBy = request.requestedByUserId
        ? await userRepository.findById(request.requestedByUserId, tx)
        : null;
      return {
        request: toOrganizationDeletionRequestDTO(request),
        scheduledByName: scheduledBy?.name ?? null,
      };
    });
  },

  /**
   * The name of the closing organization that owns `workspaceId`, or null when
   * it is open — the page header's read-only note (MOTIR-6403, design MOTIR-6390
   * panel 6). A workspace member is always an org member, so the caller has
   * already been admitted to the workspace; the read is SYSTEM-scoped like
   * `isWorkspaceOrgClosing`, and returns nothing but a name the member's own
   * closing bar already shows.
   */
  async getClosingOrganizationName(workspaceId: string): Promise<string | null> {
    return withSystemContext((tx) =>
      organizationRepository.findClosingNameByWorkspaceId(workspaceId, tx),
    );
  },

  /**
   * What deleting the organization would take — the dialog's step 1 (MOTIR-6402,
   * design MOTIR-6390 panel 2). Owner-only, like the act it describes: a
   * non-member 404, an Admin or Member 403.
   *
   * The capability is asserted in the org's own context; the counts are then read
   * in SYSTEM context, because they cross every workspace of the org and the
   * repository rows the Git offboarding walks (the erasure reads them the same
   * way). Read-only.
   */
  async getConsequences(
    organizationId: string,
    actorUserId: string,
    sessionSignedInAt: Date,
    now: Date = new Date(),
  ): Promise<OrganizationDeletionConsequencesDTO> {
    const memberCount = await withOrgContext(
      { userId: actorUserId, organizationId },
      async (tx) => {
        await assertOrgCapability(actorUserId, organizationId, 'deleteOrganization', tx);
        return organizationMembershipRepository.countByOrg(organizationId, tx);
      },
    );
    const hostOwner = provisioningOrgLogin();
    const { workspaces, projectCount, repos } = await withSystemContext(async (tx) => ({
      workspaces: await workspaceRepository.listByOrganization(organizationId, tx),
      projectCount: await projectRepository.countByOrganization(organizationId, tx),
      repos: await githubRepoRepository.listByOrganizationWithInstallation(organizationId, tx),
    }));
    const { hasPassword } = await usersService.getPasswordCapability(actorUserId);
    return {
      workspaceNames: workspaces.map((w) => w.name),
      projectCount,
      memberCount,
      hostedRepos: repos
        .filter((r) => r.provider === 'github')
        .filter((r) => isMotirHostedOwner(r.owner, hostOwner))
        .map((r) => ({ id: r.id, fullName: `${r.owner}/${r.name}` })),
      erasureDueAt: erasureDueAt(now).toISOString(),
      hasPassword,
      signedInRecently: now.getTime() - sessionSignedInAt.getTime() <= STEP_UP_WINDOW_MS,
    };
  },
};
