import { Prisma, type MigrateOnboarding, type MigrateOnboardingStep } from '@prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toMigrateOnboardingDto } from '@/lib/mappers/migrateOnboardingMappers';
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
// 7.15 · MOTIR-1499) — the SCAFFOLDING slice. It stands up the durable,
// resumable substrate that the wiring slice (MOTIR-931) drives: the persisted
// run, the read paths, and one transition method PER step with the canonical
// verify → advance → kick shape. Two seams are STUBS here for 931 to fill: the
// per-step EXIT-CHECK (each `verifyExit` below gates on the persisted per-step
// output — the resumable minimum; 931 deepens it to the real signal, e.g.
// polling the index/discovery/generation job's terminal state) and the KICK that
// starts the next step's action (`kickStepAction`, a no-op here). No `motir-ai`
// import; every DB op goes through the repository; the service owns the
// transaction (the 4-layer rule, CLAUDE.md).
//
// RESUMABLE by shape: `step` is persisted and re-read on every transition (under
// a row lock), so there is no restart-from-`connect` path — a resumed run picks
// up at its saved step, and a double-advance / concurrent loser is rejected by
// the step guard.

/**
 * The exit-condition SEAM for a step (MOTIR-931 deepens each). Throws
 * `MigrateOnboardingExitConditionError` when the current step's output has not
 * landed yet, so the run cannot advance. `undefined` = the step has no local
 * gate in the scaffold (the `review` approval is a 931-wired user action).
 */
type ExitCheck = (run: MigrateOnboarding) => void;

/**
 * KICK SEAM (MOTIR-931): start the action that drives the step just ENTERED
 * toward its exit condition — begin code-graph indexing, submit the discovery /
 * generation job, open the plan review, etc. A no-op in this scaffolding slice;
 * 931 replaces the body with the real per-step orchestration. Isolated in one
 * place so the transition methods keep their stable verify→advance→kick shape
 * while 931 fills only this seam.
 */
async function kickStepAction(
  step: MigrateOnboardingStep,
  run: MigrateOnboarding,
  tx: Prisma.TransactionClient,
): Promise<void> {
  // Intentionally empty until MOTIR-931 wires each step's orchestration.
  void step;
  void run;
  void tx;
}

/**
 * The shared transition mechanic every `advanceFrom*` method runs through:
 * resolve + access-gate the run, then in ONE workspace-scoped transaction lock
 * the row, re-read it fresh, assert it is at the `from` step (the resumability /
 * lost-race guard), run the step's exit-check seam (a), advance the saved step —
 * completing the run on the terminal `done` hop (b), and kick the entered step's
 * action seam (c). Returns the updated run as a DTO.
 */
async function advance(
  id: string,
  ctx: ServiceContext,
  spec: { from: MigrateOnboardingStep; to: MigrateOnboardingStep; verifyExit: ExitCheck },
): Promise<MigrateOnboardingDto> {
  const existing = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
  if (!existing) throw new MigrateOnboardingNotFoundError(id);
  await projectAccessService.assertCanEdit(existing.projectId, ctx);

  const row = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
    async (tx) => {
      const locked = await migrateOnboardingRepository.lockById(id, tx);
      if (!locked) throw new MigrateOnboardingNotFoundError(id);
      const fresh = await migrateOnboardingRepository.findById(id, ctx.workspaceId, tx);
      if (!fresh) throw new MigrateOnboardingNotFoundError(id);

      // The step guard: this transition is legal ONLY from its `from` step. A
      // resumed run re-reads its saved step here, so a double-advance or a
      // concurrent loser (which observes the already-advanced step under the
      // lock) is rejected rather than skipping a step.
      if (fresh.step !== spec.from) {
        throw new MigrateOnboardingStepError(id, fresh.step, spec.from);
      }

      // (a) verify the current step's exit condition — SEAM (MOTIR-931).
      spec.verifyExit(fresh);

      // (b) advance the saved step; the terminal `done` hop completes the run.
      const isTerminal = spec.to === 'done';
      const updated = await migrateOnboardingRepository.update(
        id,
        { step: spec.to, ...(isTerminal ? { status: 'completed' } : {}) },
        tx,
      );

      // (c) kick the entered step's action — SEAM (MOTIR-931).
      await kickStepAction(spec.to, updated, tx);
      return updated;
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
   *  it does not resolve in this workspace. */
  async getById(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    const row = await migrateOnboardingRepository.findById(id, ctx.workspaceId);
    if (!row) throw new MigrateOnboardingNotFoundError(id);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    return toMigrateOnboardingDto(row);
  },

  // ── Step transitions — one per step, each verify → advance → kick ───────────

  /** connect → index. Exit: a repo has been connected. */
  async advanceFromConnect(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, {
      from: 'connect',
      to: 'index',
      verifyExit: (run) => {
        if (!run.connectedRepoRef) {
          throw new MigrateOnboardingExitConditionError(
            'connect',
            'no repo has been connected yet.',
          );
        }
      },
    });
  },

  /** index → audit_convention. Exit: the repo is indexed into the code graph. */
  async advanceFromIndex(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, {
      from: 'index',
      to: 'audit_convention',
      verifyExit: (run) => {
        if (!run.codeGraphReady) {
          throw new MigrateOnboardingExitConditionError(
            'index',
            'the code graph is not ready yet.',
          );
        }
      },
    });
  },

  /** audit_convention → discovery. Exit: the coding convention was approved. */
  async advanceFromAuditConvention(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, {
      from: 'audit_convention',
      to: 'discovery',
      verifyExit: (run) => {
        if (!run.conventionApprovedAt) {
          throw new MigrateOnboardingExitConditionError(
            'audit_convention',
            'the coding convention has not been approved yet.',
          );
        }
      },
    });
  },

  /** discovery → generate. Exit: a discovery job has been recorded. */
  async advanceFromDiscovery(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, {
      from: 'discovery',
      to: 'generate',
      verifyExit: (run) => {
        if (!run.discoveryJobId) {
          throw new MigrateOnboardingExitConditionError(
            'discovery',
            'no discovery job has been recorded yet.',
          );
        }
      },
    });
  },

  /** generate → review. Exit: a code-aware generation job has been recorded. */
  async advanceFromGenerate(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, {
      from: 'generate',
      to: 'review',
      verifyExit: (run) => {
        if (!run.generateJobId) {
          throw new MigrateOnboardingExitConditionError(
            'generate',
            'no generation job has been recorded yet.',
          );
        }
      },
    });
  },

  /**
   * review → done (completes the run). The review approval is a user action the
   * wiring slice (MOTIR-931) gates; the scaffold treats reaching `review` as
   * sufficient to complete, so the exit-check is an empty 931 seam.
   */
  async advanceFromReview(id: string, ctx: ServiceContext): Promise<MigrateOnboardingDto> {
    return advance(id, ctx, {
      from: 'review',
      to: 'done',
      verifyExit: () => {
        // SEAM (MOTIR-931): the plan-review approval gate. No local field gates
        // it in the scaffold — reaching `review` is enough to complete.
      },
    });
  },
};
