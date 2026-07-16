import { Prisma, type MigrateOnboarding, type MigrateOnboardingStep } from '@prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ProjectContext } from '@/lib/projects';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { importRepository } from '@/lib/repositories/importRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { planRepository } from '@/lib/repositories/planRepository';
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
 *  direction docs exist. */
const DISCOVERY: StepWiring = {
  from: 'discovery',
  to: 'generate',
  async ensureKicked({ run, pctx }) {
    if (run.discoveryJobId) return; // idempotent — one discovery job per run
    const { jobId } = await aiChatService.submitDiscoveryTurn(MIGRATE_DISCOVERY_PROMPT, pctx);
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
 *  review/approve surface; this step gates on that approval, then completes. */
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
    async (tx) => {
      const locked = await migrateOnboardingRepository.lockById(id, tx);
      if (!locked) throw new MigrateOnboardingNotFoundError(id);
      const fresh = await migrateOnboardingRepository.findById(id, ctx.workspaceId, tx);
      if (!fresh) throw new MigrateOnboardingNotFoundError(id);
      if (fresh.step !== wiring.from) {
        throw new MigrateOnboardingStepError(id, fresh.step, wiring.from);
      }
      const isTerminal = wiring.to === 'done';
      return migrateOnboardingRepository.update(
        id,
        { ...(patch ?? {}), step: wiring.to, ...(isTerminal ? { status: 'completed' } : {}) },
        tx,
      );
    },
  );
  return toMigrateOnboardingDto(row);
}

export const migrateOnboardingService = {
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
