import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { MotirAiError } from '@/lib/ai/errors';
import type { JobContextBag, JobKind, JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { NoPlanForJobError } from '@/lib/plans/errors';

import { plansService } from '@/lib/services/plansService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { PlanJobStateDto, PlanOriginDto, PlanOutcomeDto } from '@/lib/dto/plans';
import { projectAccessService } from '@/lib/services/projectAccessService';

// ⚠️ There is NO approve here, by design (MOTIR-1747). A plan edit's proposals
// land in the run's `Plan` (`addProposals` → `markPlanned`), and the ONE path
// that turns proposals into work items is `plansService.approvePlan` →
// `materialize`, behind the 7.12.5 persist gate. This service used to carry a
// second one — `approveDelta`, reading the job result's `planDelta` — which every
// planner returned empty, so it could only ever write nothing; it is retired
// along with its route, its client helper and the delta shape gate.

export class InvalidTargetError extends Error {
  readonly code = 'INVALID_TARGET' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidTargetError';
  }
}

function buildTenant(ctx: ProjectContext, organizationId: string, isMeta: boolean) {
  return {
    organizationId,
    isMeta,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    projectKey: ctx.project.identifier,
  };
}

/** The job kinds a plan EDIT submits — the 7.11/7.12 set (`generate_tree` is
 *  `aiGenerationService`'s). All three write their output through the 7.21
 *  Plan/PlanItem proposal store. */
type PlanEditJobKind = Extract<JobKind, 'augment' | 'expand_item' | 'replan'>;

/**
 * The ids a plan-edit submit hands back.
 *
 * The shape GREW a `planId` alongside `jobId` (MOTIR-1743) — the decision the
 * bug asked to record: it mirrors `aiGenerationService.startGeneration`'s
 * `{ jobId, planId }` exactly, so both producers into the 7.21 Plan substrate
 * return the same pair, and a caller that wants to link the user straight to
 * `/plans/<id>` no longer has to re-resolve the plan by `sourceJobId`. It is
 * ADDITIVE: the REST routes echo it, and every existing consumer
 * (`planEditsClient`, `usePlanEditsJob`, `planChangeSessionsService`)
 * destructures `{ jobId }` and reads the new field defensively (optional in the
 * browser-facing client types, since a stubbed/older response carries only
 * `jobId`).
 */
export interface PlanEditSubmitResult {
  jobId: string;
  planId: string;
}

/**
 * Per-submit knobs that describe the SUBMIT, not the planning request itself
 * (nothing here reaches motir-ai — the job envelope is unchanged).
 *
 * `origin` (MOTIR-916) stamps the opened Plan's provenance. Every request-path
 * caller omits it and gets `user`; the auto-plan cadence watcher passes
 * `cadence` so the review surface can label an expansion nobody clicked.
 */
export interface PlanEditSubmitOptions {
  origin?: PlanOriginDto;
}

/**
 * Submit a plan-edit job AND open the `generating` `Plan` its proposals append
 * into — the ONE shared step every plan-edit submit needs (MOTIR-1743).
 *
 * Before this, the four submits stopped at `submitJob`, so no `Plan` existed for
 * the job. But motir-ai's `augment` / `expand_item` / `replan` handlers write
 * their output through the Plan/PlanItem proposal store (`addProposals` →
 * `markPlanned`), and the core seam those callbacks land on
 * (`aiGenerationService.appendProposals`) resolves the plan by `sourceJobId` —
 * so EVERY plan-edit job died on its first callback with
 * `NoPlanForJobError` → 404. Opening the plan here is the missing half.
 *
 * Order is deliberate and copied from `startGeneration`: the job is submitted
 * FIRST so the Plan can bind to it via `sourceJobId`, and so a failed submit
 * (motir-ai unreachable / out-of-credits) leaves NO orphan Plan behind — the
 * typed `MotirAiError` propagates before any row is written.
 *
 * The Plan is opened untitled (`title`/`summary` null), exactly as
 * `startGeneration` does by default; the review surfaces already render the
 * `untitledPlan` fallback.
 */
/**
 * Assert the actor may run a planning job on this project — `ai:plan`
 * (Story MOTIR-2291 · Subtask MOTIR-2357).
 *
 * ⚠️ CALLED AT THE TOP OF EACH PUBLIC METHOD, not inside `submitPlanEditJob`.
 * The one-seam version is tidier and is WRONG: `submitExpand` and `submitReplan`
 * resolve their target work item first, so a gate behind them answers "no such
 * item" to an actor who is not allowed to ask the question — a target oracle for
 * anyone who can reach the route. The gate goes before the lookup.
 *
 * This service carried no assertion of its own. The guard read four of its five
 * operations as governed only because of something else the ROUTE happened to
 * call, which is exactly the indirection a named key replaces; a planning job
 * spends the workspace's AI credits, so the key is deliberately narrower than
 * `work_item:edit`.
 */
async function assertCanPlan(ctx: ProjectContext): Promise<void> {
  await projectAccessService.assertPermission(
    ctx.projectId,
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    'ai:plan',
  );
}

async function submitPlanEditJob(
  kind: PlanEditJobKind,
  context: JobContextBag,
  ctx: ProjectContext,
  opts: PlanEditSubmitOptions = {},
): Promise<PlanEditSubmitResult> {
  const { organizationId, isMeta } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const code = await resolveCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const tenant = buildTenant(ctx, organizationId, isMeta);
  const { jobId } = await submitJob(
    kind,
    tenant,
    {
      ...context,
      // The AI-drafted-explanations opt-in (Story 7.4 · MOTIR-850), on the wire
      // for plan EDITS too (MOTIR-2110). `startGeneration` has always sent it on
      // `generate_tree`, and the contract is that motir-ai reads the flag ONLY
      // from `context.generateExplanations` and never from motir-core config —
      // so a submit that omits it cannot be compensated for on the far side, and
      // the project setting silently stopped applying the moment the plan moved
      // off its first generation. Re-plan is where a plan spends most of its
      // life, so most nodes were being born without the WHY.
      //
      // Set HERE, on the one shared submit, rather than in `submitReplan` alone:
      // the anchor set makes the submitted kind only a FALLBACK (see
      // `submitContextual`) — motir-ai's scoping module classifies a contextual
      // turn and can resolve an `augment` submit into a re-plan — so a
      // replan-only site would still drop the flag on the contextual path. Same
      // field name, same source (`Project.aiGenerateExplanations`, a non-null
      // boolean column), no new config path; ALWAYS present, `false` when off,
      // exactly as the `generate_tree` submit sends it.
      generateExplanations: ctx.project.aiGenerateExplanations,
      ...(code ? { code } : {}),
    },
    { userId: ctx.userId },
  );
  const plan = await plansService.createPlan(
    ctx.projectId,
    { title: null, summary: null, sourceJobId: jobId, origin: opts.origin ?? 'user' },
    ctx,
  );
  return { jobId, planId: plan.id };
}

/**
 * How the caller addresses the plan whose outcome it wants — by the `planId` a
 * submit returned, or by the `jobId` it returned alongside. Both come out of the
 * SAME `{ jobId, planId }` pair, so a client that persisted either one can ask.
 */
export type PlanOutcomeRef = { planId: string } | { jobId: string };

/**
 * Resolve the motir-ai job behind a still-`generating` plan.
 *
 * This is the ONLY way to tell a run that is still working from one that DIED:
 * a failed job leaves its plan at `generating` forever (nothing writes a
 * terminal plan state on failure), so a caller polling the plan alone would wait
 * on it indefinitely. A motir-ai outage is reported as `reachable: false` rather
 * than thrown, because the PLAN read already succeeded — degrading the job block
 * beats failing an answer we largely have.
 */
async function resolveJobState(jobId: string): Promise<PlanJobStateDto> {
  try {
    const job = await getJob(jobId);
    return {
      status: job.status,
      reachable: true,
      failure: job.error ? { code: job.error.code, message: job.error.message } : null,
    };
  } catch (err) {
    if (err instanceof MotirAiError) {
      return { status: null, reachable: false, failure: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

export const aiPlanEditsService = {
  /**
   * What became of a submitted plan job (MOTIR-1825) — the companion READ to
   * every `{ jobId, planId }` submit, for a client with no stream to hold open.
   *
   * Reports the PLAN's own status plus its proposal COUNT, and — only while the
   * plan is still `generating` — the job's state, so "still running" and "died"
   * are distinguishable (see {@link resolveJobState}).
   *
   * Reads nothing into the tree and writes nothing: the count is of PROPOSALS.
   * `plansService.approvePlan` remains the only path from a proposal to a work
   * item, so a caller that polls this to completion still has an unchanged tree
   * until a human approves.
   */
  async getOutcome(ref: PlanOutcomeRef, ctx: ServiceContext): Promise<PlanOutcomeDto> {
    let planId: string;
    if ('planId' in ref) {
      planId = ref.planId;
    } else {
      const resolved = await plansService.findPlanIdForJob(ref.jobId, ctx);
      if (!resolved) throw new NoPlanForJobError(ref.jobId);
      planId = resolved;
    }
    const plan = await plansService.getPlan(planId, ctx);
    const job =
      plan.status === 'generating' && plan.sourceJobId
        ? await resolveJobState(plan.sourceJobId)
        : null;
    return {
      planId: plan.id,
      projectId: plan.projectId,
      status: plan.status,
      origin: plan.origin,
      jobId: plan.sourceJobId,
      itemCount: plan.itemCount,
      createdAt: plan.createdAt,
      plannedAt: plan.plannedAt,
      decidedAt: plan.decidedAt,
      job,
    };
  },

  async submitAugment(prompt: string, ctx: ProjectContext): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    return submitPlanEditJob('augment', { prompt }, ctx);
  },

  /**
   * Submit a CONTEXTUAL planning turn — a chat turn anchored at one or more work
   * items (7.12.3 · MOTIR-909), riding the SHIPPED 7.11 job contract.
   *
   * Two things make this different from {@link submitAugment}, and only two:
   *
   *  1. `context.targetKeys` carries the anchor SET. That flag is what turns the
   *     submit into a contextual turn on the motir-ai side (7.12.2 · MOTIR-908):
   *     the scoping module CLASSIFIES the intent from the turn text, RESOLVES which
   *     of `expand_item` / `augment` / `replan` it really is (structure overrides
   *     text — a leaf cannot be expanded; a subtask re-plan climbs to its story),
   *     and pushes the UNION of every anchor's item + parent + siblings + children
   *     as grounding.
   *  2. The submitted kind is therefore only the FALLBACK when the turn text
   *     carries no signal, and `augment` — additions-only — is deliberately that
   *     floor: the safest thing to do with an ambiguous instruction is propose
   *     ADDITIONS, never a re-shape. Core does NOT pre-classify; that would put two
   *     classifiers in the loop and let core's guess override the engine's.
   *
   * The re-plan "reason" is the turn text itself — there is no separate `reason`
   * param, by contract. NO new job kind is introduced. Nothing is written to the
   * TREE here: this SUBMITS and opens the job's empty `generating` Plan (the
   * proposal sink — MOTIR-1743); no work item is touched, and persisting a
   * returned delta stays behind the confirmation gate (7.13.5) on the approve
   * route.
   */
  async submitContextual(
    prompt: string,
    targetKeys: readonly string[],
    ctx: ProjectContext,
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    return submitPlanEditJob('augment', { prompt, targetKeys: [...targetKeys] }, ctx);
  },

  /** The live channel for a contextual planning turn's job — the same 7.1.4 job
   *  stream every plan-edit surface relays, named for its caller so the panel's
   *  route reads as one seam. Browsers stream from CORE, never from motir-ai. */
  streamContextual(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  async submitExpand(
    itemKey: string,
    ctx: ProjectContext,
    opts: PlanEditSubmitOptions = {},
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const wi = await workItemRepository.findByIdentifier(ctx.projectId, itemKey);
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const containerKinds = new Set(['epic', 'story', 'task', 'bug']);
    if (!containerKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — expand requires a container (epic/story/task/bug)`,
      );
    }

    return submitPlanEditJob('expand_item', { rootItemKey: itemKey }, ctx, opts);
  },

  async submitReplan(itemKey: string, ctx: ProjectContext): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const wi = await workItemRepository.findByIdentifier(ctx.projectId, itemKey);
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const replanKinds = new Set(['epic', 'story']);
    if (!replanKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — replan requires an epic or story`,
      );
    }

    return submitPlanEditJob('replan', { rootItemKey: itemKey }, ctx);
  },

  streamAugment(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  streamExpand(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },

  streamReplan(jobId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId);
  },
};
