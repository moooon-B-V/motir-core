import { Prisma, type MigrateOnboarding, type MigrateOnboardingStep } from '@/lib/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ProjectContext } from '@/lib/projects';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { importRepository } from '@/lib/repositories/importRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ExistingWorkItemRef } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { toMigrateOnboardingDto } from '@/lib/mappers/migrateOnboardingMappers';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { aiChatService } from '@/lib/services/aiChatService';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { aiPreplanService } from '@/lib/services/aiPreplanService';
import type {
  MigrateIndexStatusDto,
  MigrateOnboardingDto,
  StartMigrateOnboardingInput,
} from '@/lib/dto/migrateOnboarding';
import {
  MigrateOnboardingExistsError,
  MigrateOnboardingExitConditionError,
  MigrateOnboardingNotFoundError,
  MigrateOnboardingStepError,
} from '@/lib/migrateOnboarding/errors';

// The migrate-existing-codebase onboarding state machine ("Workflow B", Story
// 7.15) — the WIRING slice (MOTIR-931) that drives the SLICE-A scaffold
// (MOTIR-1499). SLICE-A stood up the persisted run, the read paths, the row-lock
// step guard, and one transition method PER step with the verify → advance shape;
// this slice fills the two seams it left: the per-step KICK (start the action
// that drives a step toward its exit) and the deepened EXIT CHECK (poll the REAL
// signal each owning story produces), plus the resumable API (its routes).
//
// EACH STEP CALLS THE OWNING STORY'S SHIPPED SURFACE — re-implementing none:
//   connect  → the GitHub grant (7.10) — a connected repo set (resolveCodeContext)
//   index    → the code-graph index job (7.5) — its terminal state in the job_run
//              ledger (jobRunRepository); the wizard WAITS, it does not index
//              (the grant flow enqueues the index — `enqueueCodeGraphIndex`)
//   audit_convention → the audit + propose_convention derivation (7.14 ·
//              aiConventionService.reaudit); DERIVED + AUTO-USED, no approval gate
//              and never a wizard gate (decision MOTIR-1660) — kicked silently,
//              advances immediately
//   discovery → a short discovery job (7.3 · aiChatService.submitDiscoveryTurn);
//              exit: direction docs exist (aiPreplanService.getPreplanState)
//   generate → code-aware generation (7.4 · aiGenerationService.startGeneration,
//              which reads the code graph via resolveCodeContext); exit: the plan
//              is `planned`
//   review   → the standard plan review/approve (7.21) — exit: the plan is
//              `approved`; on approve the run completes
//
// SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): the kicks (submit motir-ai jobs, read the
// grant/graph over the network) and the real-signal polls run BEFORE the short
// advance transaction — a run row is never locked across a motir-ai / DB
// round-trip. The transaction only locks the row, re-reads + re-asserts the step
// (the resumability / lost-race guard), persists the observed signal, and moves
// the step. No `motir-ai` import — every AI call goes through a motir-core service
// / the 7.1 client (`lib/ai/*`); every DB op goes through a repository.
//
// RESUMABLE by shape: `step` is persisted and re-read (under a row lock) on every
// transition; the kicks are IDEMPOTENT (skip when the step's output already
// exists) so a resumed run — or one whose kick was dropped — re-checks and
// re-kicks rather than restarting from `connect` or double-submitting.

/** A migrate-variant discovery turn: one short, code-first framing of the
 *  existing project. motir-ai owns the interview + the direction docs it yields;
 *  motir-core only forwards the turn. */
const MIGRATE_DISCOVERY_PROMPT =
  'This is an existing codebase being onboarded to Motir. Using the connected ' +
  "repository's code graph as the ground truth, summarize the project's purpose, " +
  'the current state of the code, and the most valuable directions to plan next.';

/** The per-step reason surfaced on a 409 when a step cannot yet advance. */
const EXIT_REASON: Record<MigrateOnboardingStep, string> = {
  connect: 'no repository has been connected yet.',
  index: 'the code graph is still indexing.',
  import: 'no import has been completed or skipped yet.',
  audit_convention: 'the coding convention has not been derived yet.',
  discovery: 'the discovery step has not produced direction docs yet.',
  generate: 'the plan has not finished generating yet.',
  review: 'the plan has not been approved yet.',
  done: 'the run is already complete.',
};

/** What a step's exit poll observes: whether it may advance, and any signal to
 *  persist as part of the advance (e.g. the resolved repo ref, `codeGraphReady`,
 *  the auto-accept timestamp). */
interface ExitResult {
  ready: boolean;
  patch?: Prisma.MigrateOnboardingUncheckedUpdateInput;
}

interface StepInput {
  run: MigrateOnboarding;
  pctx: ProjectContext;
  ctx: ServiceContext;
}

/** One step's wiring: the hop, the (idempotent, best-effort where the story is
 *  fire-and-forget) KICK of the step's driving action, and the real-signal EXIT
 *  poll. Both hooks run OUTSIDE the advance transaction. */
interface StepWiring {
  from: MigrateOnboardingStep;
  to: MigrateOnboardingStep;
  ensureKicked?: (input: StepInput) => Promise<void>;
  checkExit: (input: StepInput) => Promise<ExitResult>;
}

/** Build the run's project context (the `projectKey`/identifier the AI services
 *  need) from the persisted run — the transitions are keyed by run id, not by the
 *  actor's active project, so the project is resolved from the row. */
async function resolveProjectContext(
  projectId: string,
  ctx: ServiceContext,
): Promise<ProjectContext> {
  const project = await projectsService.assertProjectInWorkspace(projectId, ctx.workspaceId);
  return {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    project: toProjectDTO(project),
  };
}

/** connect → index. Exit: a connected repository exists for the workspace (the
 *  GitHub grant mirror). No kick — the user connects the repo in GitHub settings;
 *  the wizard only observes it. */
const CONNECT: StepWiring = {
  from: 'connect',
  to: 'index',
  async checkExit({ run, ctx }) {
    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    const firstRepo = code?.repos[0];
    if (!firstRepo) return { ready: false };
    // Record WHICH repo backs the run (the connect-time ref, else the first
    // connected repo) so the `index` step can match its code-graph index job.
    const repoRef = run.connectedRepoRef ?? firstRepo.repoRef;
    return { ready: true, patch: { connectedRepoRef: repoRef } };
  },
};

/** index → import. The index completed — advance to the optional import step. */
const INDEX: StepWiring = {
  from: 'index',
  to: 'import',
  async checkExit({ run, ctx }) {
    if (run.codeGraphReady) return { ready: true };
    if (!run.connectedRepoRef) return { ready: false };
    const succeeded = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        jobRunRepository.findSucceededCodeGraphIndex(ctx.workspaceId, run.connectedRepoRef!, tx),
    );
    if (!succeeded) return { ready: false };
    return { ready: true, patch: { codeGraphReady: true } };
  },
};

/** import → audit_convention. OPTIONAL step — exit when the user either completed
 *  an import (a succeeded/partially_failed `Import` row exists for this project)
 *  or explicitly skipped it. No kick — the user does the import in the standalone
 *  import wizard or skips; this step only polls the outcome. */
const IMPORT: StepWiring = {
  from: 'import',
  to: 'audit_convention',
  async checkExit({ run, ctx }) {
    // Already marked done (skip or completion persisted on a prior advance).
    if (run.importSkipped || run.importCompleted) return { ready: true };
    // Poll: has any import completed for this project?
    const completed = await importRepository.findCompletedForProject(
      run.projectId,
      ctx.workspaceId,
    );
    if (completed) {
      return { ready: true, patch: { importCompleted: true } };
    }
    return { ready: false };
  },
};

/** audit_convention → discovery. DERIVED + AUTO-USED, never a gate (MOTIR-1660):
 *  kick the audit + propose_convention derivation SILENTLY (best-effort) and
 *  advance immediately — the convention is used automatically; the audit +
 *  read-only view live on the post-onboarding Code-health page, not here. */
const AUDIT_CONVENTION: StepWiring = {
  from: 'audit_convention',
  to: 'discovery',
  async ensureKicked({ run, pctx, ctx }) {
    if (run.conventionApprovedAt) return; // already derived on a prior pass
    // Best-effort + silent: a convention-derivation blip must never gate
    // onboarding (MOTIR-1660). Fire the audit + propose_convention job and move
    // on; its result surfaces later on the Code-health page.
    try {
      await aiConventionService.reaudit(
        run.projectId,
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        pctx.project.identifier,
      );
    } catch (err) {
      console.error(
        `migrate-onboarding ${run.id}: audit_convention derivation kick failed (non-blocking):`,
        err,
      );
    }
  },
  async checkExit({ run }) {
    // Non-blocking auto-use: reaching audit_convention is enough to advance.
    // Stamp the auto-accept time (repurposing the SLICE-A field as "derived +
    // auto-accepted at", since there is no human approval per MOTIR-1660).
    return { ready: true, patch: { conventionApprovedAt: run.conventionApprovedAt ?? new Date() } };
  },
};

/** discovery → generate. Kick a short migrate-variant discovery job; exit when
 *  direction docs exist. For a project with existing work items (MOTIR-1259),
 *  the existing tree is passed as grounding context — motir-ai's discovery
 *  handler uses it to draft tiers that complement what already exists, never a
 *  blank slate. */
const DISCOVERY: StepWiring = {
  from: 'discovery',
  to: 'generate',
  async ensureKicked({ run, pctx }) {
    if (run.discoveryJobId) return; // idempotent — one discovery job per run
    // Read the project's existing work-item tree to ground tier drafting
    // (MOTIR-1259). Use the unpaginated findAllByProjectForValidity projection —
    // we only need key + kind + title + status + parentKey, not full WorkItem
    // rows. A project with no items → empty list → blank-slate discovery.
    let existingWorkItems: ExistingWorkItemRef[] | undefined;
    try {
      const rows = await workItemRepository.findByProject(pctx.projectId, { take: 200 });
      if (rows.length > 0) {
        existingWorkItems = rows.map((r) => ({
          key: r.identifier,
          kind: r.kind,
          title: r.title,
          status: r.status,
          parentKey: r.parentId,
        }));
      }
    } catch (err) {
      // Non-blocking: a failed item read (e.g. the project was just deleted
      // concurrent with a resumed onboarding run) must never gate the discovery
      // step. Log and proceed with a blank slate — the handler will operate on
      // the prompt alone.
      console.error(
        `migrate-onboarding ${run.id}: failed to read existing work items for discovery grounding (non-blocking):`,
        err,
      );
    }
    const { jobId } = await aiChatService.submitDiscoveryTurn(MIGRATE_DISCOVERY_PROMPT, pctx, {
      existingWorkItems,
    });
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: run.projectId },
      (tx) => migrateOnboardingRepository.update(run.id, { discoveryJobId: jobId }, tx),
    );
  },
  async checkExit({ pctx }) {
    const preplan = await aiPreplanService.getPreplanState(pctx);
    return { ready: preplan.docs.length > 0 };
  },
};

/** generate → review. Kick the code-aware generation (its Plan binds via the
 *  job's sourceJobId); exit when the plan is `planned`.
 *
 *  CODE-AWARE PRECONDITION (MOTIR-933): generation MUST NOT start unless the
 *  code graph is indexed AND the coding convention has been derived. A missing
 *  precondition fails cleanly with a typed error — no silent blank-slate
 *  fallback (the exact failure migrate onboarding exists to prevent). */
const GENERATE: StepWiring = {
  from: 'generate',
  to: 'review',
  async ensureKicked({ run, pctx }) {
    if (!run.codeGraphReady) {
      throw new MigrateOnboardingExitConditionError(
        'generate',
        'the code graph is not ready — the index step must complete first.',
      );
    }
    if (!run.conventionApprovedAt) {
      throw new MigrateOnboardingExitConditionError(
        'generate',
        'the coding convention has not been derived yet — the audit_convention step must complete first.',
      );
    }
    if (run.generateJobId) return; // idempotent — one generation per run
    // Reconcile: when the optional import step completed, enrich the prompt with
    // imported-work-item context so the code-aware plan de-dupes against the
    // imported backlog (MOTIR-1643).
    const genInput: Parameters<typeof aiGenerationService.startGeneration>[1] = {};
    if (run.importCompleted) {
      const completedImport = await importRepository.findCompletedForProject(
        run.projectId,
        pctx.workspaceId,
      );
      if (completedImport) {
        genInput.prompt =
          `This project has work items imported from ${completedImport.source}. ` +
          `The existing backlog already tracks ${completedImport.createdCount} items ` +
          `(with ${completedImport.updatedCount} updated and ${completedImport.skippedCount} skipped). ` +
          `Generate a plan that complements the imported backlog — de-duplicate: ` +
          `do NOT propose work items that are already covered by an imported item. ` +
          `Focus on the gaps the codebase implies.`;
      }
    }
    const { jobId } = await aiGenerationService.startGeneration(pctx, genInput);
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: run.projectId },
      (tx) => migrateOnboardingRepository.update(run.id, { generateJobId: jobId }, tx),
    );
  },
  async checkExit({ run, ctx }) {
    if (!run.generateJobId) return { ready: false };
    const plan = await planRepository.findBySourceJobId(run.generateJobId, ctx.workspaceId);
    return { ready: plan?.status === 'planned' || plan?.status === 'approved' };
  },
};

/** review → done. No kick — the user approves the plan via the standard plan
 *  review/approve surface; this step gates on that approval, then completes.
 *
 *  NOT the only path to `completed` any more (MOTIR-2092). This hop is the one
 *  the WIZARD walks, and it only happens if the tab is still open when the plan
 *  is approved — `plansService.approvePlan` stamps `project.onboardingRanAt` in
 *  the approve's own transaction, and the client is then expected to come back
 *  for this. `runTerminalReconciliation` completes the runs where it never did. */
const REVIEW: StepWiring = {
  from: 'review',
  to: 'done',
  async checkExit({ run, ctx }) {
    if (!run.generateJobId) return { ready: false };
    const plan = await planRepository.findBySourceJobId(run.generateJobId, ctx.workspaceId);
    return { ready: plan?.status === 'approved' };
  },
};

/**
 * THE COMMIT SHAPE — the one place a step advance is written, shared by ALL
 * THREE callers that can perform one: the user-driven `advance()` below, the
 * system-driven index sweep (MOTIR-2082) and the terminal reconciliation
 * (MOTIR-2092). Runs inside a transaction the caller opens, because they arrive
 * with different tenancy: `advance()` has an acting user
 * (`withWorkspaceContext`), the two sweeps have none
 * (`withWorkspaceServiceContext`). Everything AFTER the context — lock, re-read,
 * re-assert, update — is identical by construction rather than by three
 * similar-looking implementations drifting apart.
 *
 * Take the row lock, re-read the CURRENT row under it, re-assert the
 * preconditions the caller checked outside the transaction, then persist the
 * observed signal + the step hop (completing the run on the terminal `done`
 * hop). This is the lock-before-read-derived-update rule (`notes.html` #35): the
 * step read before the lock is stale by construction, so nothing derived from it
 * may be written without re-reading under the lock.
 *
 * `onPreconditionMiss` picks what a lost race MEANS to the caller:
 *   * `'throw'` (the wizard) — a double-click / wrong-step call is a 409, the
 *     shipped behaviour the routes and their tests depend on.
 *   * `'skip'` (the sweep) — a run the wizard advanced first is a normal no-op,
 *     not an error; returns `null` so the sweep records it and moves on.
 */
async function commitAdvance(
  args: {
    id: string;
    workspaceId: string;
    /** Only the HOP is needed here — `Pick` rather than a full `StepWiring` so
     *  the reconciliation can hand in a synthesized `{ from: <wherever the run
     *  is>, to: 'done' }` hop, which has no exit poll of its own. */
    wiring: Pick<StepWiring, 'from' | 'to'>;
    patch?: Prisma.MigrateOnboardingUncheckedUpdateInput;
    /** Also re-assert `status` under the lock (the sweep: a run marked `failed`
     *  between the scan and the commit must not be advanced). */
    requireActive?: boolean;
    onPreconditionMiss: 'throw' | 'skip';
  },
  tx: Prisma.TransactionClient,
): Promise<MigrateOnboarding | null> {
  const { id, workspaceId, wiring, patch, requireActive, onPreconditionMiss } = args;
  const locked = await migrateOnboardingRepository.lockById(id, tx);
  if (!locked) {
    if (onPreconditionMiss === 'skip') return null;
    throw new MigrateOnboardingNotFoundError(id);
  }
  const fresh = await migrateOnboardingRepository.findById(id, workspaceId, tx);
  if (!fresh) {
    if (onPreconditionMiss === 'skip') return null;
    throw new MigrateOnboardingNotFoundError(id);
  }
  if (fresh.step !== wiring.from || (requireActive && fresh.status !== 'active')) {
    if (onPreconditionMiss === 'skip') return null;
    throw new MigrateOnboardingStepError(id, fresh.step, wiring.from);
  }
  const isTerminal = wiring.to === 'done';
  return migrateOnboardingRepository.update(
    id,
    { ...(patch ?? {}), step: wiring.to, ...(isTerminal ? { status: 'completed' } : {}) },
    tx,
  );
}

/**
 * The shared transition mechanic. Resolve + access-gate the run and its project,
 * then OUTSIDE any transaction: (1) idempotently KICK the current step's driving
 * action (a motir-ai job submit / grant read — never inside a lock), (2) POLL the
 * step's real exit signal. Only if ready, open ONE short workspace-scoped
 * transaction to lock the row, re-read + re-assert the step (the resumability /
 * lost-race guard), persist the observed signal, and advance the saved step —
 * completing the run on the terminal `done` hop. Returns the updated run as a DTO.
 */
async function advance(
  id: string,
  ctx: ServiceContext,
  wiring: StepWiring,
): Promise<MigrateOnboardingDto> {
  const existing = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
  if (!existing) throw new MigrateOnboardingNotFoundError(id);
  await projectAccessService.assertCanEdit(existing.projectId, ctx);
  // Early step check (re-asserted under the lock below) so a wrong-step call
  // fails fast without kicking a step's side effect.
  if (existing.step !== wiring.from) {
    throw new MigrateOnboardingStepError(id, existing.step, wiring.from);
  }

  const pctx = await resolveProjectContext(existing.projectId, ctx);
  let run = existing;

  // (1) Kick the current step's driving action (idempotent). A kick that submits
  // a metered motir-ai job lets its typed error (out-of-credits / transport)
  // propagate so the route maps it (402/502); a best-effort kick swallows its own.
  if (wiring.ensureKicked) {
    await wiring.ensureKicked({ run, pctx, ctx });
    // A kick may have persisted a job id — re-read so the exit poll sees it.
    const refreshed = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
    if (refreshed) run = refreshed;
  }

  // (2) Poll the real exit signal (network / ledger reads) OUTSIDE the tx.
  const { ready, patch } = await wiring.checkExit({ run, pctx, ctx });
  if (!ready) {
    throw new MigrateOnboardingExitConditionError(wiring.from, EXIT_REASON[wiring.from]);
  }

  // (3) Commit the advance under a row lock — re-read + re-assert the step so a
  // concurrent advance (or a double click) lands on the wrong-step guard.
  const row = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
    (tx) =>
      commitAdvance(
        { id, workspaceId: ctx.workspaceId, wiring, patch, onPreconditionMiss: 'throw' },
        tx,
      ),
  );
  // `onPreconditionMiss: 'throw'` never yields null — the non-null assertion is
  // the type system catching up with that, not an unchecked assumption.
  return toMigrateOnboardingDto(row!);
}

/** Page size for the sweep's cross-workspace scan — bounded (finding #57).
 *  Injectable for tests; production omits it. */
export const MIGRATE_INDEX_SWEEP_PAGE_SIZE = 200;

/** What one sweep tick did, for the job ledger. `advanced` counts rows actually
 *  moved `index → import`; `failed` counts runs whose commit threw and were
 *  isolated (a summary that hid those would make a broken sweep look idle). */
export interface MigrateIndexSweepSummary {
  /** Active runs found parked at `index` this tick. */
  scanned: number;
  /** Runs advanced `index → import`. */
  advanced: number;
  /** Runs whose commit threw — isolated, logged, retried next tick. */
  failed: number;
}

/** Page size for the terminal reconciliation's cross-workspace scan — bounded
 *  (finding #57). Injectable for tests; production omits it. */
export const MIGRATE_RECONCILE_PAGE_SIZE = 200;

/** What one reconciliation tick did, for the job ledger. `failed` is reported
 *  rather than swallowed for the same reason the index sweep reports it: a
 *  summary that hid it would make a broken lane look idle. */
export interface MigrateTerminalReconcileSummary {
  /** Active runs found on an already-established project this tick. */
  scanned: number;
  /** Runs completed from the marker (`step → done`, `status → completed`). */
  terminated: number;
  /** Runs whose commit threw — isolated, logged, retried next tick. */
  failed: number;
}

export const migrateOnboardingService = {
  /**
   * THE TERMINAL RECONCILIATION (MOTIR-2092) — complete every `active` run whose
   * project is already ESTABLISHED, deriving the terminal state from the durable
   * marker instead of a browser tab.
   *
   * ── THE SHAPE DECISION, and why it is (a) ──────────────────────────────────
   *
   * This is the THIRD defect on this state machine (MOTIR-2082, MOTIR-2090,
   * MOTIR-2092), so `notes.html` #198's repeat-defect trigger fires: the root
   * SHAPE has to be named before another patch lands on it. It is this —
   *
   *   every transition of this machine is observed only by an OPEN BROWSER TAB,
   *   and "onboarding is over" has a second, independent, durable writer
   *   (`project.onboardingRanAt`) that the run never reads.
   *
   * The alternative was (b): a fourth per-step sweep, cheaper today and the
   * third instance of the same patch. It is rejected because the population it
   * would fix is the population that has been REPORTED, not the population that
   * exists — the run has seven steps and any of them can be abandoned. This
   * mechanism reads the signal that actually MEANS "over", so it covers every
   * step and both producers at once:
   *
   *   1. THE APPROVE RACE — `plansService.approvePlan` stamps the marker in the
   *      same transaction as the approve, and only THEN is the wizard client
   *      expected to come back and land `review → done`. A tab closed in between
   *      leaves a permanently established project with a permanently `active`
   *      run. No operator involved; any project.
   *   2. THE MARKER'S OTHER WRITERS — `scripts/plan-seed/dogfoodProject.ts` and
   *      `scripts/stampOnboardingRan.ts` (MOTIR-1799) stamp it with no wizard
   *      interaction at all, so their runs are orphaned wherever they happened
   *      to be. This is the live `MOTIR` row: marker stamped 2026-08-04T16:33Z,
   *      run `active` at `index` since 2026-07-25.
   *
   * WHY NOT AT THE MARKER'S WRITER. Terminating the run inside `approvePlan`
   * would close producer 1 at its source, but it is the CLIENT-HOP shape again
   * one layer down: it only ever runs when that specific writer runs, so it
   * cannot heal the runs already orphaned (the entire motivating population),
   * cannot cover producer 2 without a third copy in each script, and adds a
   * cross-aggregate write to a transaction that is already the longest in the
   * codebase. One mechanism, reading durable state, on a schedule.
   *
   * WHERE THE RUN LANDS, and why the write is not silent. It lands at
   * `step: 'done'`, `status: 'completed'` — the SAME terminal shape a walked run
   * has, so every existing reader (the wizard page's completed-run redirect,
   * `advanceNext`'s `done` case, the index sweep's `active` filter) stays
   * correct with no new branch. But a run terminated at `review` is NOT the same
   * as one that walked there, and overwriting `step` destroys the difference in
   * place — so the write also stamps `reconciledAt` (this did not walk) and
   * `reconciledFromStep` (how far it actually got). Neither is exposed on the
   * DTO: they answer an operator/abandonment question, and no client surface
   * asks it.
   *
   * ORDER MATTERS AGAINST THE INDEX SWEEP. This runs FIRST in the lane, so an
   * orphaned run parked at `index` is completed rather than first advanced to
   * `import` by the sweep and then completed from there — which would record a
   * `reconciledFromStep` the user never reached. Once completed it is no longer
   * `active`, so the index sweep's own filter skips it.
   *
   * TENANCY is the MOTIR-2082 shape exactly: phase 1 is the one read with no
   * workspace to bind, under `withSystemContext`; phase 2 commits each run
   * inside THAT run's workspace under `withWorkspaceServiceContext`. The
   * cross-tenant reach is one bounded, read-only scan.
   *
   * A run whose project marker is NULL is untouched at every step — that is the
   * in-flight journey, and it is the regression risk here exactly as it was in
   * MOTIR-2090. The marker is the whole gate.
   */
  async runTerminalReconciliation(
    opts: { pageSize?: number } = {},
  ): Promise<MigrateTerminalReconcileSummary> {
    const pageSize = opts.pageSize ?? MIGRATE_RECONCILE_PAGE_SIZE;
    let after: string | undefined;
    let scanned = 0;
    let terminated = 0;
    let failed = 0;

    for (;;) {
      // Phase 1 — the cross-workspace discovery scan, in its OWN system-context
      // transaction (the GUC is transaction-scoped). A page is read fully before
      // any run is acted on, so no commit runs inside the scanning transaction.
      const page = await withSystemContext((tx) =>
        migrateOnboardingRepository.listActiveOnEstablishedProject(
          { take: pageSize, ...(after ? { after } : {}) },
          tx,
        ),
      );
      if (page.length === 0) break;
      scanned += page.length;

      for (const run of page) {
        try {
          // Phase 2 — the commit, in this run's OWN workspace context, through
          // the shared lock → re-read → re-assert → update shape.
          const row = await withWorkspaceServiceContext(run.workspaceId, async (tx) => {
            // Take the run's lock BEFORE re-reading the marker, so the signal
            // and the commit that acts on it observe one serialized moment.
            // `commitAdvance` re-takes this same lock below; a second `FOR
            // UPDATE` on a row this transaction already holds is a no-op.
            const locked = await migrateOnboardingRepository.lockById(run.id, tx);
            if (!locked) return null; // deleted between scan and commit
            // Re-assert the DURABLE SIGNAL itself. `markOnboardingRan` is a
            // null-guarded write and the marker's only writer, so it is
            // monotonic today and this re-read cannot change the answer — it is
            // here so that a future writer which CLEARS the marker (an
            // "un-onboard" admin action) makes this lane stop, rather than
            // silently completing runs against a signal that no longer holds.
            const project = await projectRepository.findById(run.projectId, tx);
            if (!project?.onboardingRanAt) return null;
            return commitAdvance(
              {
                id: run.id,
                workspaceId: run.workspaceId,
                // The hop is synthesized from where the run actually sits: the
                // re-assert under the lock then fails for exactly the run a live
                // wizard advanced in the meantime, so the race produces ONE
                // transition and this lane no-ops (the next tick catches it).
                wiring: { from: run.step, to: 'done' },
                patch: { reconciledAt: new Date(), reconciledFromStep: run.step },
                requireActive: true,
                onPreconditionMiss: 'skip',
              },
              tx,
            );
          });
          if (row) terminated += 1;
        } catch (err) {
          // Failure isolation: one run's commit blowing up must not stop the
          // reconciliation for any other run. The scan is re-runnable, so the
          // next tick retries this run from durable state.
          failed += 1;
          console.error(
            `migrate-onboarding terminal reconciliation: run ${run.id} failed to complete:`,
            err,
          );
        }
      }

      if (page.length < pageSize) break;
      after = page[page.length - 1]!.id;
    }

    return { scanned, terminated, failed };
  },

  /**
   * THE INDEX SWEEP (MOTIR-2082) — re-evaluate the `index` step's exit condition
   * for every run parked there, from durable state, on a schedule.
   *
   * WHY A SWEEP AND NOT A COMPLETION HOOK. `INDEX.checkExit` reads the job ledger
   * correctly, but it only ever RUNS when someone calls a transition — and the
   * only callers are the wizard client and its `index-status` poll, both in the
   * browser. Close the tab while the index is still running (the index is
   * *expected* to be slow — waiting on it is why the wizard exists) and the exit
   * condition can flip true with nobody listening; the run then sits `active` at
   * `index` indefinitely. A hook on `system.code-graph-index` would not fix that:
   * it fires only when a NEW index succeeds, so it could never heal a run whose
   * index already succeeded — which is the entire motivating population. A sweep
   * re-derives from state, so it repairs runs wedged before it shipped and is
   * robust to a dropped hook, where a hook gets no second chance.
   *
   * Immediacy is not lost. While the user IS watching, the wizard's own poll
   * still advances the run within seconds; the sweep exists for when they are not.
   *
   * WHERE IT STOPS, AND WHY THAT IS CORRECT. It advances `index → import` and
   * nothing further. It does NOT set `importSkipped`: the import step is an
   * OPTIONAL, user-owned decision (import your Jira/Linear backlog, or skip), and
   * a background job answering it would silently discard a real product choice.
   * So a swept run lands at `import` and waits for a human — not a wedge, but the
   * machine correctly parked on a decision only the user can make. The bug is
   * confined to `index`, whose exit condition is machine-observable and was
   * simply never observed.
   *
   * TENANCY, in two phases (the `autoPlanCadenceService` shape). Phase 1 is the
   * ONE read with no workspace to bind — "which runs, anywhere, are parked at
   * `index`?" — under `withSystemContext`, riding the policy's system-admin
   * branch (added for this sweep in 20260804180000). Phase 2 commits each run
   * inside THAT run's workspace under `withWorkspaceServiceContext`, which binds
   * only `app.workspace_id`: a cron tick has no acting user, so it cannot route
   * through `advance()` (gated by `projectAccessService.assertCanEdit`), but it
   * does not need — and so must not take — cross-tenant WRITE reach either. The
   * cross-tenant reach is exactly one bounded, read-only scan.
   *
   * The exit signal is read via `listSucceededCodeGraphIndexRepoRefs` ONCE PER
   * WORKSPACE rather than `findSucceededCodeGraphIndex` once per run: same
   * ledger question, one round-trip per workspace instead of N per run.
   */
  async runIndexSweep(opts: { pageSize?: number } = {}): Promise<MigrateIndexSweepSummary> {
    const pageSize = opts.pageSize ?? MIGRATE_INDEX_SWEEP_PAGE_SIZE;
    let after: string | undefined;
    let scanned = 0;
    let advanced = 0;
    let failed = 0;

    for (;;) {
      // Phase 1 — the cross-workspace discovery scan, in its OWN system-context
      // transaction (the GUC is transaction-scoped). A page is read fully before
      // any run is acted on, so no commit runs inside the scanning transaction.
      const page = await withSystemContext((tx) =>
        migrateOnboardingRepository.listActiveAtStep(
          'index',
          { take: pageSize, ...(after ? { after } : {}) },
          tx,
        ),
      );
      if (page.length === 0) break;
      scanned += page.length;

      // Group the page by workspace so the ledger question is asked once per
      // workspace. Runs with no `connectedRepoRef` never reached a repo to index
      // — `INDEX.checkExit` returns not-ready for them and so does this.
      const byWorkspace = new Map<string, typeof page>();
      for (const run of page) {
        const bucket = byWorkspace.get(run.workspaceId);
        if (bucket) bucket.push(run);
        else byWorkspace.set(run.workspaceId, [run]);
      }

      for (const [workspaceId, runs] of byWorkspace) {
        const indexedRefs = new Set(
          await withSystemContext((tx) =>
            jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
          ),
        );

        for (const run of runs) {
          // The SAME exit condition `INDEX.checkExit` applies: an already-observed
          // `codeGraphReady`, or a succeeded index row for this run's repo.
          const ready =
            run.codeGraphReady || (!!run.connectedRepoRef && indexedRefs.has(run.connectedRepoRef));
          if (!ready) continue;

          try {
            // Phase 2 — the commit, in this run's OWN workspace context, through
            // the shared lock → re-read → re-assert → update shape. A wizard
            // advance that won the race leaves the row at `import`, the re-assert
            // under the lock fails, and this returns null: exactly ONE transition
            // happens and the loser no-ops instead of throwing.
            const row = await withWorkspaceServiceContext(workspaceId, (tx) =>
              commitAdvance(
                {
                  id: run.id,
                  workspaceId,
                  wiring: INDEX,
                  patch: { codeGraphReady: true },
                  requireActive: true,
                  onPreconditionMiss: 'skip',
                },
                tx,
              ),
            );
            if (row) advanced += 1;
          } catch (err) {
            // Failure isolation: one run's commit blowing up must not stop the
            // sweep for any other run. The scan is re-runnable, so the next tick
            // retries this run from durable state.
            failed += 1;
            console.error(`migrate-onboarding index sweep: run ${run.id} failed to advance:`, err);
          }
        }
      }

      if (page.length < pageSize) break;
      after = page[page.length - 1]!.id;
    }

    return { scanned, advanced, failed };
  },

  /**
   * Begin a migrate-onboarding run for a project at the `connect` step. At most
   * ONE run per project (the DB unique index guards it; a lost create-race is
   * translated from P2002 to `MigrateOnboardingExistsError`). The connect step's
   * repo ref may be supplied now or set as connect completes.
   */
  async startMigration(
    projectId: string,
    ctx: ServiceContext,
    input: StartMigrateOnboardingInput = {},
  ): Promise<MigrateOnboardingDto> {
    await projectAccessService.assertCanEdit(projectId, ctx);
    const existing = await migrateOnboardingRepository.findByProjectId(projectId, ctx.workspaceId);
    if (existing) throw new MigrateOnboardingExistsError(projectId);

    try {
      const row = await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
        (tx) =>
          migrateOnboardingRepository.create(
            {
              workspaceId: ctx.workspaceId,
              projectId,
              kind: 'migrate',
              step: 'connect',
              status: 'active',
              connectedRepoRef: input.connectedRepoRef ?? null,
            },
            tx,
          ),
      );
      return toMigrateOnboardingDto(row);
    } catch (err) {
      // A concurrent starter won the unique-index race — surface the typed
      // domain error, never a raw P2002 (the concurrency-to-typed-error rule).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new MigrateOnboardingExistsError(projectId);
      }
      throw err;
    }
  },

  /** The resumable head read: a project's migrate-onboarding run (its saved step
   *  and progress), or null if none has been started. */
  async getForProject(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<MigrateOnboardingDto | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const row = await migrateOnboardingRepository.findByProjectId(projectId, ctx.workspaceId);
    return row ? toMigrateOnboardingDto(row) : null;
  },

  /** One run by id (browse-gated). Throws `MigrateOnboardingNotFoundError` when
   *  it does not resolve in this workspace. Re-opening resumes at the saved
   *  `step` — the resumable head read the wizard reloads from. */
  async getById(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    const row = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
    if (!row) throw new MigrateOnboardingNotFoundError(id);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    return toMigrateOnboardingDto(row);
  },

  /**
   * The Index step's live per-repo progress (Story 7.15 · MOTIR-934) — what the
   * wizard polls at `GET /api/onboarding/migrate/[id]/index-status`. Resolves the
   * workspace's connected repo set (`resolveCodeContext`, the same set the CONNECT
   * step observed) and maps each repo to `indexed` (a succeeded
   * `system.code-graph-index` run matches its `output.repoRef`) or `pending`, plus
   * the aggregate `hasRunning` flag (a running index row exists — the ledger cannot
   * tie a running row to a specific repo, so the in-flight state is aggregate).
   * `allIndexed` gates the wizard's Next button (stricter than the state machine's
   * single-`connectedRepoRef` INDEX exit, which is fine — the wizard never enables
   * Next before every repo is indexed). Browse-gated. Returns an empty `repos` list
   * (not an error) when no repo is connected yet — the wizard's Connect step
   * handles that state.
   */
  async getIndexStatus(id: string, ctx: ServiceContext): Promise<MigrateIndexStatusDto> {
    const run = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
    if (!run) throw new MigrateOnboardingNotFoundError(id);
    await projectAccessService.assertCanBrowse(run.projectId, ctx);

    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    const repos = code?.repos ?? [];

    // One workspace-scoped transaction for all the job_run reads (the job_run RLS
    // policy scopes them; `resolveCodeContext` opens its own).
    const { statuses, hasRunning } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const running = await jobRunRepository.findRunningCodeGraphIndexForWorkspace(
          ctx.workspaceId,
          tx,
        );
        const mapped = await Promise.all(
          repos.map(async (repo) => {
            const succeeded = await jobRunRepository.findSucceededCodeGraphIndex(
              ctx.workspaceId,
              repo.repoRef,
              tx,
            );
            return {
              provider: repo.provider,
              repoRef: repo.repoRef,
              status: succeeded ? ('indexed' as const) : ('pending' as const),
            };
          }),
        );
        return { statuses: mapped, hasRunning: running !== null };
      },
    );

    const indexedCount = statuses.filter((s) => s.status === 'indexed').length;
    const total = statuses.length;
    return {
      repos: statuses,
      indexedCount,
      total,
      hasRunning,
      allIndexed: total > 0 && indexedCount === total,
    };
  },

  // ── Step transitions — one per step, each kick (current) → poll → advance ────

  /** connect → index. Exit: a repo has been connected. */
  advanceFromConnect(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, CONNECT);
  },

  /** index → import. Exit: the code graph index completed. */
  advanceFromIndex(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, INDEX);
  },

  /** import → audit_convention. Exit: an import completed or was skipped. */
  advanceFromImport(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, IMPORT);
  },

  /** audit_convention → discovery. Exit: the coding convention was derived
   *  (auto-used, no gate — MOTIR-1660). */
  advanceFromAuditConvention(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, AUDIT_CONVENTION);
  },

  /** discovery → generate. Exit: direction docs exist. */
  advanceFromDiscovery(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, DISCOVERY);
  },

  /** generate → review. Exit: a code-aware plan has been generated. */
  advanceFromGenerate(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, GENERATE);
  },

  /** review → done (completes the run). Exit: the plan was approved. */
  advanceFromReview(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, REVIEW);
  },

  /**
   * Skip the OPTIONAL import step — transition `import → audit_convention`,
   * setting `importSkipped` to true. Only valid when the run is at the `import`
   * step; rejects with `MigrateOnboardingStepError` otherwise. Idempotent: a run
   * that already skipped is a no-op (returns the current row as-is).
   */
  async skipImport(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    const existing = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
    if (!existing) throw new MigrateOnboardingNotFoundError(id);
    await projectAccessService.assertCanEdit(existing.projectId, ctx);
    if (existing.step !== 'import') {
      throw new MigrateOnboardingStepError(id, existing.step, 'import');
    }
    // Already skipped or already past import — idempotent no-op.
    if (existing.importSkipped || existing.importCompleted) {
      return toMigrateOnboardingDto(existing);
    }
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
      (tx) =>
        migrateOnboardingRepository.update(
          id,
          { importSkipped: true, step: 'audit_convention' as MigrateOnboardingStep },
          tx,
        ),
    );
    return toMigrateOnboardingDto(row);
  },

  /**
   * Attempt the NEXT transition from wherever the run currently sits — the single
   * entry point the resumable `…/advance` route calls (it holds a run id, not a
   * step). Dispatches to the step-specific transition; a `done` run has nothing
   * to advance. Rejects (via the step's exit check) when the current exit
   * condition is unmet — the generic guard.
   */
  async advanceNext(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    const run = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
    if (!run) throw new MigrateOnboardingNotFoundError(id);
    switch (run.step) {
      case 'connect':
        return advance(id, ctx, CONNECT);
      case 'index':
        return advance(id, ctx, INDEX);
      case 'import':
        return advance(id, ctx, IMPORT);
      case 'audit_convention':
        return advance(id, ctx, AUDIT_CONVENTION);
      case 'discovery':
        return advance(id, ctx, DISCOVERY);
      case 'generate':
        return advance(id, ctx, GENERATE);
      case 'review':
        return advance(id, ctx, REVIEW);
      case 'done':
        throw new MigrateOnboardingExitConditionError('done', EXIT_REASON.done);
    }
  },
};
