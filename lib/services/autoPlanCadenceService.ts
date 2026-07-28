import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import { toPlanDto } from '@/lib/mappers/planMappers';
import type { AutoPlanPauseDto, PlanDto } from '@/lib/dto/plans';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Auto-plan CADENCE service (Story 7.13 · MOTIR-916) — the trigger half of
// Principle #17 ("planning is asynchronous; expand to enough work, not all the
// work"). MOTIR-904 shipped the HUMAN-facing version of this: when a project's
// ready set drains, the /ready page nudges someone to expand a stub. This
// promotes that nudge into an opt-in AUTO-trigger on the 1.6 cron substrate.
//
// It adds a TRIGGER, not a planner. Nothing here plans anything: the sweep
// decides WHETHER to start the SHIPPED 7.4 `expand_item` job and then submits it
// through the shipped `aiPlanEditsService.submitExpand`. The only thing that
// becomes automatic is the decision to start.
//
// Nothing auto-WRITES to the work-item tree, and that is enforced by the data
// model rather than by care here: the motir-ai handler streams its output back
// as `Plan` + `PlanItem` PROPOSAL rows (an `add` item's `workItemId` stays NULL
// until it materializes), and a real `work_item` row appears only when a human
// APPROVES the plan. A cadence-fired run therefore ends with a proposal waiting
// in the review queue — never with a changed tree.
//
// TENANCY, in two phases (the codeGraphIndexService / savedFilterSubscriptions
// shape). Phase 1 is the ONE read with no workspace to bind — "which projects
// opted in?" — under `withSystemContext`, riding the project policy's
// system_admin READ branch. Phase 2 runs per project inside THAT project's
// workspace context, as that workspace's owner. So the cross-tenant reach is
// exactly one bounded, read-only scan.

/** Page size for the cron's cross-workspace project scan — bounded (finding
 *  #57). Injectable for tests; production omits it. */
export const AUTO_PLAN_SCAN_PAGE_SIZE = 200;

/** Why a project was passed over on a tick. Each is a normal, expected outcome
 *  — none is an error. */
export type CadenceSkipReason =
  /** An undecided plan is already in the review queue (the pending-proposal gate). */
  | 'pending_proposal'
  /** The ready set is at or above the project's `aiAutoPlanThreshold`. */
  | 'ready_set_healthy'
  /** Nothing left to expand — no childless, non-terminal epic/story. */
  | 'no_expandable_stub'
  /** The workspace has no owner row to act as (an invariant violation, logged not thrown). */
  | 'no_owner'
  /** The project vanished between the scan and the per-project read. */
  | 'project_gone';

export type CadenceProjectOutcome =
  | { projectId: string; status: 'fired'; itemKey: string; jobId: string; planId: string }
  | { projectId: string; status: 'skipped'; reason: CadenceSkipReason }
  | { projectId: string; status: 'failed'; error: string };

export interface CadenceSweepSummary {
  /** Projects with `aiAutoPlanEnabled = true` visited this tick. */
  scanned: number;
  /** Projects an `expand_item` job was submitted for. */
  fired: number;
  /** Projects passed over for one of the {@link CadenceSkipReason}s. */
  skipped: number;
  /** Projects whose submit threw — isolated, logged, retried next tick. */
  failed: number;
  outcomes: CadenceProjectOutcome[];
}

/** The `expand_item` submit, isolated behind a seam so a unit test can drive the
 *  sweep's decision logic without a live motir-ai. Production uses the shipped
 *  service; nothing else overrides it. */
export interface CadenceDeps {
  submitExpand: typeof aiPlanEditsService.submitExpand;
}

const defaultDeps: CadenceDeps = {
  submitExpand: (itemKey, ctx, opts) => aiPlanEditsService.submitExpand(itemKey, ctx, opts),
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How many of a waiting plan's proposed items have drifted since it was drafted
 * (MOTIR-1740), via the SHIPPED `planStalenessService` (MOTIR-1340) — never a
 * second drift derivation.
 *
 * Only a `planned` plan can be stale: a `generating` one has no `plannedAt` to
 * measure drift against and is seconds old. Mirrors the Plans list's
 * `staleCountFor` (`app/(authed)/plans/planRowView.ts`), including its graceful
 * degradation — a staleness read that fails costs the indicator its drift line,
 * it does not fail the settings page that is only asking whether cadence is
 * paused.
 */
async function staleCountFor(plan: PlanDto, ctx: ServiceContext): Promise<number> {
  if (plan.status !== 'planned') return 0;
  try {
    const verdict = await planStalenessService.computePlanStaleness(plan.id, ctx);
    return verdict.items.filter((item) => item.stale).length;
  } catch {
    return 0;
  }
}

export const autoPlanCadenceService = {
  /**
   * THE pending-proposal predicate — the ONE place "is auto-planning paused for
   * this project?" is decided (MOTIR-916). The cadence sweep calls it to decide
   * whether to fire; the AI-planning settings page (MOTIR-1740) calls it to
   * SHOW the user that cadence is paused and why. Two consumers, one query, so
   * the indicator and the trigger can never disagree.
   *
   * Returns the undecided plan (`generating` / `planned`) when one exists, else
   * null. WHO started that plan is deliberately not part of the predicate — see
   * `planRepository.findUndecidedByProject`.
   *
   * ACCEPTED consequence, made legible rather than fixed: nothing expires or
   * auto-declines a `planned` plan (`declinePlan` is an explicit human action),
   * so a proposal nobody ever decides on silences cadence for that project
   * indefinitely. Declining is the release valve, and MOTIR-1740 is what makes
   * the silence visible instead of mysterious.
   */
  async getPendingPlan(projectId: string, ctx: ServiceContext): Promise<PlanDto | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) => planRepository.findUndecidedByProject(projectId, ctx.workspaceId, tx),
    );
    // itemCount is not part of the pause decision and both consumers render the
    // plan's identity/status, not its size — so this stays a single-row read
    // rather than a count join.
    return row ? toPlanDto(row, 0) : null;
  },

  /**
   * The INDICATOR read behind {@link getPendingPlan} (MOTIR-1740) — "is
   * auto-planning paused for this project, and has the plan it waits on gone out
   * of date?", for the AI-planning settings page.
   *
   * ONE PREDICATE, TWO CONSUMERS. `pending` is `getPendingPlan(...) !== null` by
   * construction — the SAME method the sweep's gate 1 calls — so the indicator
   * and the trigger cannot disagree about whether a project is paused. Nothing
   * is re-derived here: this method only PROJECTS that verdict for a reader
   * (the plan's id, its size, and whether it has drifted). The sweep deliberately
   * does NOT call this one: staleness is irrelevant to whether to fire, and a
   * cron tick should not pay for it once per project per tick.
   *
   * Contracts: PURE READ (writes nothing), BATCHED (a bounded number of
   * round-trips per plan — the plan row, one count, and `planStalenessService`'s
   * own batched reads — never per item), TENANT-SCOPED (browse asserted, and
   * every read is workspace-scoped, so a cross-tenant project is 404-not-403).
   * Staleness WARNS and never blocks: it is reported, and gates nothing.
   */
  async getAutoPlanPauseState(projectId: string, ctx: ServiceContext): Promise<AutoPlanPauseDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const pending = await this.getPendingPlan(projectId, ctx);
    if (!pending) {
      return {
        pending: false,
        planId: null,
        plannedAt: null,
        itemCount: 0,
        stale: false,
        staleCount: 0,
      };
    }

    const [itemCount, staleCount] = await Promise.all([
      planItemRepository.countByPlan(pending.id),
      staleCountFor(pending, ctx),
    ]);

    return {
      pending: true,
      planId: pending.id,
      plannedAt: pending.plannedAt,
      itemCount,
      stale: staleCount > 0,
      staleCount,
    };
  },

  /**
   * One cadence TICK: sweep every opted-in project and fire at most ONE
   * `expand_item` job per project whose ready set has drained.
   *
   * Per project, in order — the first check that matches skips the project:
   *   1. the pending-proposal gate (never stack proposals on a reviewer);
   *   2. `readyCount < aiAutoPlanThreshold` (the drain condition);
   *   3. an expandable stub exists to target.
   *
   * FAILURE ISOLATION is per project: a submit that throws (motir-ai
   * unreachable, out of credits, a vanished tenant) is captured into the summary
   * and the sweep moves on. Nothing is retried inline — the next tick re-derives
   * every condition from live state, so a failure simply means "not this tick".
   * That is also why the tick's job is `retryPolicy: 'idempotent'`: re-running
   * the whole sweep converges, because a project that DID fire now has a
   * `generating` plan and the gate skips it.
   */
  async runCadenceSweep(
    opts: { pageSize?: number; deps?: CadenceDeps } = {},
  ): Promise<CadenceSweepSummary> {
    const pageSize = opts.pageSize ?? AUTO_PLAN_SCAN_PAGE_SIZE;
    const deps = opts.deps ?? defaultDeps;
    const outcomes: CadenceProjectOutcome[] = [];
    let cursor: string | undefined;

    for (;;) {
      // Phase 1 — the cross-workspace discovery scan, in its OWN system-context
      // transaction (the GUC is transaction-scoped). Each page is read fully
      // before any project is acted on, so the submits (network calls) never run
      // inside a transaction.
      const page = await withSystemContext((tx) =>
        projectRepository.listAutoPlanEnabled(
          { take: pageSize, ...(cursor ? { cursor } : {}) },
          tx,
        ),
      );
      if (page.length === 0) break;

      for (const project of page) {
        outcomes.push(await this.runForProject(project, deps));
      }

      if (page.length < pageSize) break;
      cursor = page[page.length - 1]!.id;
    }

    return {
      scanned: outcomes.length,
      fired: outcomes.filter((o) => o.status === 'fired').length,
      skipped: outcomes.filter((o) => o.status === 'skipped').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      outcomes,
    };
  },

  /**
   * The per-project half of the sweep — the three gates and the submit. Split
   * out so the sweep's paging stays readable and each decision is unit-testable
   * on its own.
   *
   * THE ACTOR is the project's workspace OWNER. `submitJob` mints the job-scoped
   * read-back token for a specific `userId`, so motir-ai reads and proposes only
   * what that user could (contract §4b, invariant 4) — but a cron tick carries
   * no session. The owner is the only durable owner identity in the schema
   * (`Project` has no `ownerId`) and holds access to every project in the
   * workspace, so the job's read can never be narrower than the plan it reasons
   * over. NOT the system principal: `lib/ai/systemPrincipal.ts` is a member of
   * the META workspace only (provisioned for the self-learning loop's bug
   * filing) and is not a member of a customer workspace at all.
   */
  async runForProject(
    project: { id: string; workspaceId: string; aiAutoPlanThreshold: number },
    deps: CadenceDeps = defaultDeps,
  ): Promise<CadenceProjectOutcome> {
    try {
      // Re-read the row FIRST: the scan page and the act on it are separated by
      // every preceding project's work, so a project can be deleted mid-tick.
      // Reading it here means a vanished project is a clean skip rather than a
      // ProjectNotFoundError thrown out of the first gate — and the row is
      // needed anyway to build the ProjectContext the submit takes.
      const row = await projectRepository.findById(project.id);
      if (!row) return { projectId: project.id, status: 'skipped', reason: 'project_gone' };

      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(project.workspaceId);
      if (!owner) return { projectId: project.id, status: 'skipped', reason: 'no_owner' };

      const svcCtx: ServiceContext = { userId: owner.userId, workspaceId: project.workspaceId };

      // Gate 1 — the pending-proposal gate, FIRST and cheapest: a project whose
      // proposal is still undecided is skipped outright, before any ready-set
      // work. Stacking a second proposal on the same committed tree lands
      // overlapping children the reviewer must reconcile by hand, and makes the
      // pending one stale.
      const pending = await this.getPendingPlan(project.id, svcCtx);
      if (pending) return { projectId: project.id, status: 'skipped', reason: 'pending_proposal' };

      // Gate 2 — the drain condition, read through the SHIPPED ready-set count
      // (`countReady`, the same predicate /ready renders) so cadence can never
      // disagree with what the user sees. Not a re-derivation.
      const { count } = await workItemsService.countReady(project.id, {}, svcCtx);
      if (count >= project.aiAutoPlanThreshold)
        return { projectId: project.id, status: 'skipped', reason: 'ready_set_healthy' };

      // Gate 3 — the target, from the SHIPPED nomination MOTIR-904 already makes
      // (highest-priority childless, non-terminal epic/story). A project with a
      // drained ready set and nothing left to expand fires nothing — expanding
      // is not always the answer, and a false nag every tick would be worse.
      const stubs = await workItemRepository.findExpandableStubs(project.id, project.workspaceId);
      const nominated = stubs[0];
      if (!nominated)
        return { projectId: project.id, status: 'skipped', reason: 'no_expandable_stub' };

      const projectCtx: ProjectContext = {
        userId: owner.userId,
        workspaceId: project.workspaceId,
        projectId: project.id,
        project: toProjectDTO(row),
      };

      // ONE job, through the shipped submit path — which opens the `generating`
      // Plan the proposals append into and stamps it `origin: 'cadence'`, the
      // provenance the review surface labels.
      const { jobId, planId } = await deps.submitExpand(nominated.identifier, projectCtx, {
        origin: 'cadence',
      });
      return {
        projectId: project.id,
        status: 'fired',
        itemKey: nominated.identifier,
        jobId,
        planId,
      };
    } catch (err) {
      // Isolated, never rethrown: one project's motir-ai outage must not abort
      // the sweep for every other tenant. The message rides the run-ledger
      // summary so the 1.6.5 operator dashboard shows what happened.
      console.error(
        `[auto-plan-cadence] expand submit failed for project ${project.id}:`,
        errorMessage(err),
      );
      return { projectId: project.id, status: 'failed', error: errorMessage(err) };
    }
  },
};
