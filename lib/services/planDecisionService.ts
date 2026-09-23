import type { ApprovalGate, Plan } from '@/generated/prisma/client';
import type { ApprovalGateDecisionSourceDTO } from '@/lib/dto/approvalGate';
import type { PlanDto, PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { DecisionStamp } from '@/lib/approvalGates/stamp';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import {
  PlanDecisionStampRequiredError,
  PlanNotDecidableYetError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
} from '@/lib/plans/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { plansService } from '@/lib/services/plansService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// EVERY DECISION OF A PLAN, AT ONE ENTRANCE (Story MOTIR-6012 · Subtask MOTIR-6038; ADR
// `docs/decisions/approval-gates.md` §11.4, §11.5, §11.8).
//
// The plan page, the planning rail (and its close guard's *Confirm & add*), the `/ready`
// expansion nudge, the onboarding approve and the v1 plan-approval route (`motir auto
// --auto-approve-replan`) all decide a plan HERE, and this decides it through the ONE
// decide door (`approvalGatesService.decide`) whenever the plan's question is asked — an
// `awaiting` `plan_approval` gate exists. So there is one record of every plan decision:
// who, under what authority, against which version.
//
// ⚠️ WHAT STAYS A PLAIN WRITE (§11.8 item 5), and it is the ONLY one here: declining a
// plan NOBODY IS BEING ASKED ABOUT — `generating` (a discard: it never finished) or
// `stale` (its question was superseded). There is no gate to lock or record, so it goes
// through `plansService.declineUnaskedPlan`, whose body still refuses under the plan lock
// if a gate was raised meanwhile. The other plain status writers (markPlanned, drift, the
// last-withdrawal discard, the abandoned sweep) never pass through an entrance at all.
//
// ⚠️ A `planned` PLAN WITH NO GATE IS NOT DECIDABLE YET (the pre-backfill state,
// MOTIR-6039). Deciding it around the door would write the one decision the record
// could not show, so every entrance refuses with `PlanNotDecidableYetError`.
//
// ⚠️ THE STAMP IS THE READER'S. A person's press hands back the `stamp` the review read
// returned (`PlanReviewDto.gate.stamp`); the door recomputes it under the lock and
// refuses a stale one. The ONE server-derived stamp is the v1 route's
// ({@link planDecisionService.approveForWorkItem}), whose caller is an unattended loop
// that never rendered the plan — the card says so (MOTIR-6038, "the route derives it
// server-side").

const KIND = 'plan_approval' as const;

/**
 * A stamp that matches no digest. Handed to the door ONLY for a gate that is no longer
 * `awaiting`, which the door refuses on its STATE before it ever compares a stamp — so a
 * surface that rendered no stamp still hears *already decided* / *withdrawn* in the door's
 * own words. Were the gate somehow awaiting, this would be refused stale, never accepted.
 */
const NO_STAMP_RENDERED = 'plan-gate:no-stamp-rendered';

export type PlanDecisionVerb = 'approve' | 'decline';

export interface DecidePlanInput {
  planId: string;
  /** What the reader was shown (`PlanReviewDto.gate.stamp`); null when they were shown
   *  no question (a `generating` plan's discard, a plan with no gate). */
  stamp: DecisionStamp | null;
  /** Through which surface the decision arrived (ADR §6a) — required, no default. */
  source: ApprovalGateDecisionSourceDTO;
  /** Optional on both verbs (§11.4 — a decline's reason is optional by design). */
  noteMd?: string | null;
}

export interface DecidePlanOptions {
  /**
   * The onboarding draft's placeholder project name (MOTIR-1486 / MOTIR-1551), resolved
   * by the route because i18n stays out of the service layer. The approve renames the
   * draft from the plan's `productName` only while the name is still this placeholder —
   * carried through the door as the effect's own option, never dropped.
   */
  provisionalProjectName?: string | null;
}

/** The plan and its latest `plan_approval` gate (the awaiting one when there is one). */
async function planAndGate(
  planId: string,
  ctx: ServiceContext,
): Promise<{ plan: Plan; gate: ApprovalGate | null }> {
  const found = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const plan = await planRepository.findById(planId, ctx.workspaceId, tx);
    if (!plan) return null;
    return {
      plan,
      gate: await approvalGateRepository.findLatestCardlessBySubject(KIND, plan.id, tx),
    };
  });
  if (!found) throw new PlanNotFoundError(planId);
  // The decide key, BEFORE any refusal names the plan's state — exactly where
  // `approvePlan` / `declinePlan` always asserted it (a non-browser reads 404).
  await projectAccessService.assertPermission(found.plan.projectId, ctx, 'ai:decide_plan');
  return found;
}

/**
 * Decide a plan whose question is (or was) asked, through the door. Throws the door's
 * typed refusals unchanged — the same ones every other gate surface hears.
 */
async function decideThroughDoor(
  gate: ApprovalGate,
  decision: PlanDecisionVerb,
  input: DecidePlanInput,
  ctx: ServiceContext,
  opts: DecidePlanOptions,
): Promise<void> {
  if (gate.state === 'awaiting' && input.stamp === null) {
    throw new PlanDecisionStampRequiredError(input.planId);
  }
  await approvalGatesService.decide(
    {
      gateId: gate.id,
      decision,
      noteMd: input.noteMd ?? null,
      source: input.source,
      stamp: input.stamp ?? NO_STAMP_RENDERED,
    },
    ctx,
    opts.provisionalProjectName
      ? { effectOptions: { provisionalProjectName: opts.provisionalProjectName } }
      : {},
  );
}

/** A plan with no gate at all: `planned` is not decidable yet; anything else is not in
 *  a status the verb acts on (`generating` for approve — the v1 loop's *not yet*). */
function refuseUngated(plan: Plan, decision: PlanDecisionVerb): never {
  if (plan.status === 'planned') throw new PlanNotDecidableYetError(plan.id);
  throw new PlanNotInExpectedStatusError(
    plan.id,
    plan.status,
    decision === 'approve' ? 'planned' : 'planned, stale or generating',
  );
}

export const planDecisionService = {
  /**
   * APPROVE a plan — through the door, always. Returns the plan as it stands after the
   * commit (the materialized ids on its proposals), the shape every entrance already reads.
   */
  async approve(
    input: DecidePlanInput,
    ctx: ServiceContext,
    opts: DecidePlanOptions = {},
  ): Promise<PlanWithItemsDto> {
    const { plan, gate } = await planAndGate(input.planId, ctx);
    if (!gate) refuseUngated(plan, 'approve');
    await decideThroughDoor(gate, 'approve', input, ctx, opts);
    return plansService.getPlan(plan.id, ctx);
  },

  /**
   * DECLINE a plan — through the door when its question is asked; a PLAIN write when
   * nobody is being asked about it (`generating` / `stale`, §11.8 item 5), which records
   * no gate decision because there is none to record.
   */
  async decline(input: DecidePlanInput, ctx: ServiceContext): Promise<PlanDto> {
    const { plan, gate } = await planAndGate(input.planId, ctx);
    const asked = gate?.state === 'awaiting';
    if (!asked && (plan.status === 'generating' || plan.status === 'stale')) {
      return plansService.declineUnaskedPlan(plan.id, ctx);
    }
    if (!gate) refuseUngated(plan, 'decline');
    await decideThroughDoor(gate, 'decline', input, ctx, {});
    return plansService.getPlan(plan.id, ctx);
  },

  /**
   * APPROVE THE PLAN A CARD PRODUCED — the bounded entrance `POST
   * /api/v1/work-items/{key}/plan-approval` drives (MOTIR-3021 / MOTIR-3023; moved here
   * from `plansService.approvePlanForWorkItem` by MOTIR-6038). The anchoring walk and
   * its keys are unchanged: `ai:view_plan` to resolve, `ai:decide_plan` to decide.
   *
   * ⚠️ THE STAMP IS DERIVED SERVER-SIDE, and only here. The caller is an operator's loop
   * that read the plan through `GET …/plan-approval` (whose shape stays unchanged) and
   * never rendered a gate, so there is no reader's stamp to hand back. The stamp is the
   * render read's (`approvalGatesService.getForPlan`) — a real digest, so the door still
   * refuses a plan whose proposals moved between that read and its lock, and the record
   * carries the version approved. The decision is recorded `source: 'api'`.
   */
  async approveForWorkItem(
    projectId: string,
    workItemKey: string,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:view_plan');
    const planId = await plansService.resolvePlanIdForWorkItem(projectId, workItemKey, ctx);
    const read = await approvalGatesService.getForPlan({ planId }, ctx);
    try {
      return await planDecisionService.approve({ planId, stamp: read.stamp, source: 'api' }, ctx);
    } catch (err) {
      // ⚠️ THE PUBLIC CONTRACT KEEPS ITS 409 SHAPE (MOTIR-3025). A loop branches on
      // `PLAN_NOT_IN_EXPECTED_STATUS` + `planStatus` — `generating` waits, a decided plan
      // stops — so a plan the door says is already decided or withdrawn is answered as
      // the status it is in, never as a gate code the CLI does not read.
      throw await planDecisionService.asPlanStatusRefusal(err, planId, ctx);
    }
  },

  /**
   * The door's two refusals of a question that is no longer asked — already decided,
   * withdrawn — as the PLAN's status refusal, for the two callers whose contract is the
   * plan's status rather than the gate's: the v1 route (a loop reads `planStatus`) and
   * `plansService.approvePlan` / `declinePlan`'s documented one-shot guard. Any other
   * error is returned unchanged.
   */
  async asPlanStatusRefusal(err: unknown, planId: string, ctx: ServiceContext): Promise<unknown> {
    if (
      !(err instanceof ApprovalGateAlreadyDecidedError) &&
      !(err instanceof ApprovalGateSupersededError)
    ) {
      return err;
    }
    const now = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    return new PlanNotInExpectedStatusError(planId, now?.status ?? 'unknown', 'planned');
  },
};
