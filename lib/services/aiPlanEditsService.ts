import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import {
  RECORD_PLANNING_MISTAKES_CONTEXT_FIELD,
  resolveRecordPlanningMistakesForJob,
} from '@/lib/ai/lessonCapture';
import { ONBOARDING_CONTEXT_FIELD, onboardingContextFor } from '@/lib/ai/onboardingContext';
import { resolveProjectRepoContext } from '@/lib/ai/projectRepoContext';
import { MotirAiError } from '@/lib/ai/errors';
import type { JobContextBag, JobStreamEvent, SubmittedRequirement } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  NoPlanForJobError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';

import { plansService } from '@/lib/services/plansService';
import type { PlanRevisionAgentActor } from '@/lib/services/planRevisionsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { PlanJobStateDto, PlanOriginDto, PlanOutcomeDto } from '@/lib/dto/plans';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

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

function buildTenant(
  ctx: ProjectContext,
  organizationId: string,
  isMeta: boolean,
  internalBilling: boolean,
) {
  return {
    organizationId,
    isMeta,
    internalBilling,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    projectKey: ctx.project.identifier,
  };
}

/**
 * ⚠️ `PlanEditJobKind` IS GONE (MOTIR-4304). It named the 7.11/7.12 subset a plan
 * EDIT could submit — `augment` / `expand_item` / `replan` — and after ADR
 * `session-model.md` §6 step 2 there is one planning kind, `plan`, for all six
 * submit sites. `submitPlanEditJob` lost its `kind` parameter with it: a
 * parameter with one legal value is a parameter that will drift.
 *
 * What each site names is now the CONTEXT, which is what motir-ai resolves the
 * target arm from — `context.planId` a plan, `context.rootItemKey` /
 * `context.targetKeys` a work item, neither the project. Nothing about the
 * context changes here; only the kind does.
 */

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
  context: JobContextBag,
  ctx: ProjectContext,
  opts: PlanEditSubmitOptions = {},
): Promise<PlanEditSubmitResult> {
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const code = await resolveCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  // The PROJECT's repository SET (MOTIR-3044), on THIS shared submit rather than
  // per operation — for the same reason `generateExplanations` is set here: the
  // anchor set makes the submitted kind only a FALLBACK, so a per-kind site would
  // still drop the field on the contextual path. One site therefore covers
  // `augment`, `expand_item`, `replan` and every contextual turn, which is what
  // makes "every planning operation carries it" a property of the code rather
  // than of the test that happened to drive one.
  const repositories = await resolveProjectRepoContext(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  // May this project's planner record what it got wrong (MOTIR-3350)? Resolved
  // on THIS shared submit for exactly the reason the two lines above are: the
  // anchor set makes the submitted kind only a FALLBACK, so a per-kind site would
  // drop the flag on the contextual path — and a dropped flag here reads on the
  // far side as "old producer", i.e. as ON, which is the wrong answer for a
  // project that switched it off.
  const recordPlanningMistakes = await resolveRecordPlanningMistakesForJob(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const tenant = buildTenant(ctx, organizationId, isMeta, internalBilling);
  const { jobId } = await submitJob(
    // ONE planning kind (ADR `session-model.md` §6 step 2). Every planning submit
    // in the product sends this; motir-ai reads WHAT the run is about off the
    // context bag, not off a name.
    'plan',
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
      // ALWAYS present, `false` when off — never spread-conditionally like `code`
      // and `repositories` below. Those two use absence to mean "this workspace
      // has none"; here absence means "the producer predates the field" and the
      // consumer reads it as ON, so omitting it when the setting is off would
      // silently keep capturing. The key is the constant, not a literal: there is
      // no shared type across the boundary and a typo is not a type error.
      [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: recordPlanningMistakes,
      // Is this the project's FIRST plan (MOTIR-4736)? On THIS shared submit for
      // exactly the reason the three lines above are: the anchor set makes the
      // submitted kind only a FALLBACK, so a per-kind site would drop the field
      // on the contextual path. One site covers `augment`, `expand_item`,
      // `replan` and every contextual turn.
      //
      // ALWAYS present, `false` once `onboardingRanAt` is stamped — never spread
      // conditionally: absence means "the producer predates this field" and sends
      // motir-ai back to inferring onboarding from an empty tree (MOTIR-4178),
      // which is the guess this field exists to replace.
      [ONBOARDING_CONTEXT_FIELD]: onboardingContextFor(ctx.project),
      ...(code ? { code } : {}),
      ...(repositories ? { repositories } : {}),
    },
    { userId: ctx.userId },
  );
  // WHO ASKED (MOTIR-2986) — and this is the ONE seam where the acting user is
  // not always the answer. `submitPlanJob` serves BOTH the request paths (expand
  // / augment / replan / contextual, `origin: 'user'`) and the auto-plan cadence
  // watcher, which calls it with `origin: 'cadence'` under the PROJECT OWNER's
  // credential (`autoPlanCadenceService` builds `{ userId: owner.userId }` so the
  // job has one). Nobody clicked on that path, so recording the owner would
  // attribute to them a request they never made. The requester is therefore
  // written ⟺ a person actually asked, and `origin` is what identifies the rest.
  const origin = opts.origin ?? 'user';
  const plan = await plansService.createPlan(
    ctx.projectId,
    {
      title: null,
      summary: null,
      sourceJobId: jobId,
      origin,
      createdById: origin === 'user' ? ctx.userId : null,
      // WHO WROTE it (MOTIR-2996) — and unlike `createdById` above, this one
      // does NOT vary by path. Every submit this seam serves (expand / augment /
      // replan / contextual, and the cadence watcher) hands the tree to motir-ai
      // to write, so Motir is the author of all of them; only the REQUESTER
      // differs. Recording it retires the `sourceJobId != null` inference the
      // Plans surface stood on.
      //
      // SERVER-SET here, exactly as `create_plan` fixes `mcp`
      // (`agent-authored-plans.md` Q3: the source is never a caller field).
      // `authorModel` stays null — the planning LLM is motir-ai's
      // (`PlanningRun.model`) and Decision 6 strips a native model at the read
      // boundary regardless.
      authorSource: 'native',
      authorHarness: 'Motir',
    },
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
 * This is the ONLY way to tell a run that is still working from one that DIED —
 * the plan row cannot answer it. A job that fails writes NO terminal plan state
 * of its own (motir-ai's inbound seams are the success path: `appendProposals` /
 * `patchProposal`), so nothing about the plan changes when its producer stops.
 * A caller polling the plan alone would therefore wait on it indefinitely.
 *
 * ⚠️ IT IS NO LONGER *FOREVER*, AND THIS FUNCTION IS WHY (MOTIR-3064). Such a
 * plan is now reconciled OUT of `generating` by
 * `abandonedPlanService.reconcileAbandoned`, a cron sweep that calls THIS
 * resolver for every empty, producer-bearing plan past its grace and writes
 * `declined` on the ones whose job is terminal or gone. So the state is
 * eventually terminal — but only eventually, on the sweep's cadence, and this
 * remains the only way to know NOW. That is exactly why the `job` block stays on
 * `getOutcome`: a client polling a live submit must not have to wait for a cron
 * tick to learn its run died.
 *
 * A motir-ai outage is reported as `reachable: false` rather than thrown,
 * because the PLAN read already succeeded — degrading the job block beats
 * failing an answer we largely have. The sweep leans on the same distinction in
 * the other direction: unreachable is NOT evidence of death, so it terminates
 * nothing on that arm.
 *
 * Exported (MOTIR-3064) so the sweep asks the job through the ONE resolver the
 * product already uses, rather than deriving a second opinion from `getJob`.
 */
export async function resolveJobState(
  jobId: string,
  coreProjectId: string,
): Promise<PlanJobStateDto> {
  try {
    const job = await getJob(jobId, coreProjectId);
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
        ? await resolveJobState(plan.sourceJobId, plan.projectId)
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

  /**
   * Submit a project-wide planning turn — the `augment` floor, additions-only.
   *
   * `requirement` (Story MOTIR-3942 · MOTIR-4172) is the optional six-field WHAT
   * the caller settled before submitting. It rides the context bag to
   * `context.requirement`, where motir-ai's `readSuppliedPart1` reads it.
   *
   * ⚠️ SPREAD CONDITIONALLY, exactly like `code` and `repositories` and for
   * exactly their meaning of absence: a missing key says NOBODY SUPPLIED ONE,
   * which is the answer the consumer already handles by opening the
   * conversation. Sending `null` or `{}` would be a supplied-but-empty
   * requirement, a third state nothing on either side has a reading for. It is
   * deliberately NOT the `generateExplanations` / `recordPlanningMistakes`
   * discipline — those are settings whose absence must not be mistaken for a
   * default, so they are always sent.
   */
  async submitAugment(
    prompt: string,
    ctx: ProjectContext,
    requirement?: SubmittedRequirement,
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    return submitPlanEditJob({ prompt, ...(requirement ? { requirement } : {}) }, ctx);
  },

  /**
   * Submit a CONTEXTUAL planning turn — a chat turn anchored at one or more work
   * items (7.12.3 · MOTIR-909), riding the SHIPPED 7.11 job contract.
   *
   * Two things make this different from {@link submitAugment}, and only two —
   * `requirement` is carried identically by both (see {@link submitAugment}), and
   * saying so is the point: a dispatched agent's re-plan is always ANCHORED, so
   * the augment arm is the one that would drop the value unnoticed.
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
    requirement?: SubmittedRequirement,
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    return submitPlanEditJob(
      { prompt, targetKeys: [...targetKeys], ...(requirement ? { requirement } : {}) },
      ctx,
    );
  },

  /** The live channel for a contextual planning turn's job — the same 7.1.4 job
   *  stream every plan-edit surface relays, named for its caller so the panel's
   *  route reads as one seam. Browsers stream from CORE, never from motir-ai. */
  streamContextual(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  async submitExpand(
    itemKey: string,
    ctx: ProjectContext,
    opts: PlanEditSubmitOptions = {},
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const wi = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(ctx.projectId, itemKey, tx),
    );
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const containerKinds = new Set(['epic', 'story', 'task', 'bug']);
    if (!containerKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — expand requires a container (epic/story/task/bug)`,
      );
    }

    return submitPlanEditJob({ rootItemKey: itemKey }, ctx, opts);
  },

  /**
   * REVISE the plan the reviewer is holding (Story MOTIR-3595 · Subtask
   * MOTIR-3599) — the first submit whose target is a PLAN.
   *
   * ⚠️ IT DOES NOT OPEN A PLAN, and that is the whole story in one line. Every
   * sibling submit goes through `submitPlanEditJob`, whose last act is
   * `plansService.createPlan` — correct for a pass that produces a new proposal
   * set, and exactly wrong here: the reviewer asked for THIS plan to change, and
   * a second plan in the review queue is the outcome they were trying to avoid by
   * not declining. So the returned `planId` is the one that was passed in, and a
   * test asserts the identity rather than the shape.
   *
   * The order is deliberate and is not the sibling's:
   *
   *  1. **ACQUIRE THE LEASE FIRST.** It is what serializes two reviewers pressing
   *     Send at once, and what refuses a decision racing the revision
   *     (`agent-authored-plans.md` AMENDMENT 10 D2). Acquiring after the submit
   *     would let two jobs exist for one plan, the loser of the acquire having
   *     already been dispatched.
   *  2. **SUBMIT**, and RELEASE the lease if it throws — an unreachable motir-ai
   *     or an out-of-credits refusal must not hold a plan for the whole lease
   *     window over a job that never started.
   *  3. **RE-POINT `sourceJobId`** at the revision job, which is how the internal
   *     seams resolve *the job's plan* (`findBySourceJobId`) with no second
   *     resolution path and no new column. The field's own meaning is unchanged —
   *     WHICH JOB — it simply becomes the job that most recently WROTE this plan,
   *     which is what every reader of it actually wants; and the lease is what
   *     makes a single scalar safe, because one plan is revised by one job.
   */
  async submitRevise(
    planId: string,
    prompt: string,
    ctx: ProjectContext,
  ): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);

    // Resolved through the service, so a plan in ANOTHER project is refused as
    // NOT-FOUND rather than as forbidden: `getPlan` asserts browse access on the
    // plan's own project, and a caller who cannot browse it must not learn it
    // exists (the no-existence-leak posture the whole tree keeps).
    const plan = await plansService.getPlan(planId, ctx);
    if (plan.projectId !== ctx.projectId) throw new PlanNotFoundError(planId);

    const actor: PlanRevisionAgentActor = {
      source: 'native',
      harness: 'Motir',
      model: null,
    };

    // ── TWO CHEAP REFUSALS BEFORE A JOB IS SPENT ─────────────────────────────
    // The ACQUIRE below is the authority and re-checks both under the plan row
    // lock. These are here so the two refusals a reviewer actually hits — a
    // decided plan, and a plan somebody is already revising — cost nothing: a
    // job dispatched and then refused is an AI call the org paid for and nobody
    // can read.
    if (plan.status !== 'generating' && plan.status !== 'planned') {
      throw new PlanNotEditableError(planId, plan.status);
    }
    const held = await plansService.readRevisionLease(planId, ctx);
    if (held) throw new PlanRevisionInFlightError(planId, held.heldBy, held.expiresAt);

    let jobId: string;
    try {
      const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      const code = await resolveCodeContext({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      const repositories = await resolveProjectRepoContext(ctx.projectId, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      // MOTIR-4343. `submitRevise` is the OTHER submit that bypasses
      // `submitPlanEditJob` — deliberately, because a revision holds a lease and
      // must not open a second plan — so it never reached the resolution that
      // sits inside that shared submit, and a project with capture switched off
      // was still captured on every revision. Resolved for the SUBMITTING
      // project: `ctx.projectId` is the one the plan was just proved to belong
      // to (the `PlanNotFoundError` guard above), so this is the same project
      // whose setting the reviewer configured.
      const recordPlanningMistakes = await resolveRecordPlanningMistakesForJob(ctx.projectId, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      const submitted = await submitJob(
        // ONE planning kind (ADR §6 step 2). `context.planId` below is what makes
        // this a REVISION on the far side — `readerForPlan`'s first arm — so it is
        // the only thing distinguishing it on the wire now, and its silent loss
        // would route every revision to the project arm.
        'plan',
        buildTenant(ctx, organizationId, isMeta, internalBilling),
        {
          // The PLAN is the target. `planId` is the only address a revision has —
          // its proposals have no `MOTIR-<n>` until somebody approves them, which
          // is the gap this job kind exists to close.
          planId,
          prompt,
          generateExplanations: ctx.project.aiGenerateExplanations,
          // ALWAYS present, `false` when off — the same discipline as the shared
          // submit above, and for the same reason: absence reads as ON.
          [RECORD_PLANNING_MISTAKES_CONTEXT_FIELD]: recordPlanningMistakes,
          // The onboarding marker (MOTIR-4736). `submitRevise` is the OTHER
          // submit that bypasses `submitPlanEditJob`, so like the consent flag it
          // has to be set here or it is never set at all. Same discipline again:
          // ALWAYS present, never spread conditionally.
          [ONBOARDING_CONTEXT_FIELD]: onboardingContextFor(ctx.project),
          ...(code ? { code } : {}),
          ...(repositories ? { repositories } : {}),
        },
        { userId: ctx.userId },
      );
      jobId = submitted.jobId;
    } catch (err) {
      // Nothing to unwind: the lease is taken BELOW, so a submit that never
      // returned a job id has left the plan exactly as it found it.
      throw err;
    }

    // ⚠️ ACQUIRE AFTER THE SUBMIT, because the acquire is what BINDS the plan to
    // this job (`sourceJobId`) and the id does not exist until motir-ai answers.
    // Folding the bind into the acquire is what keeps them atomic — a plan leased
    // to a job the internal seams cannot resolve would be worse than either
    // failure alone — and it is why there is no separate bind door.
    //
    // The residual race, stated rather than hidden: two reviewers pressing Send
    // in the same instant both dispatch, and the loser's acquire is REFUSED. Its
    // job is then orphaned — it resolves no plan by `sourceJobId` and fails its
    // first callback, writing nothing. That costs one wasted AI call on a genuine
    // simultaneous race, which the pre-check above already removes for every
    // non-simultaneous one, and it is the cheaper end of the trade: the
    // alternative holds a lease over a job that may never exist.
    await plansService.acquireRevisionLease(planId, ctx, actor, { jobId });
    return { jobId, planId };
  },

  async submitReplan(itemKey: string, ctx: ProjectContext): Promise<PlanEditSubmitResult> {
    await assertCanPlan(ctx);
    const wi = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(ctx.projectId, itemKey, tx),
    );
    if (!wi || wi.projectId !== ctx.projectId) {
      throw new InvalidTargetError(`Work item ${itemKey} not found in this project`);
    }
    const replanKinds = new Set(['epic', 'story']);
    if (!replanKinds.has(wi.kind)) {
      throw new InvalidTargetError(
        `Work item ${itemKey} is a ${wi.kind} — replan requires an epic or story`,
      );
    }

    return submitPlanEditJob({ rootItemKey: itemKey }, ctx);
  },

  streamAugment(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  streamExpand(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  streamReplan(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  streamRevise(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },
};
