import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import { fetchPlanReview, PlanRequestError } from '@/lib/planning/planReviewClient';

// What every AI-planning surface does with a Plan ON TOP of the raw calls in
// `planReviewClient` (MOTIR-1746/1747). The conversational rail, the item-scoped
// expand/re-plan dock and the `/ready` expansion nudge all ask the same three
// questions — is there a proposal pending? what did the approve land? what does
// a failed decision mean? — so the answers live here once, and the invariant
// "ONE review shape, ONE confirm, whoever pulled the trigger" cannot drift into
// three slightly different versions of itself.

/**
 * The run's PROPOSALS, or `null` when there is nothing to decide.
 *
 * A plan is reviewable only while it is UNDECIDED and carries items:
 * `generating` is still filling, and `approved` / `declined` is already decided.
 * Every AI surface settles a finished run through this — never through the job
 * result, whose `planDelta` is empty by construction (MOTIR-1747).
 *
 * ⚠️ `stale` IS REVIEWABLE, AND THIS PREDICATE HAD TO WIDEN FOR IT
 * (MOTIR-3579). It read `=== 'planned'`, and the fifth status is neither
 * `planned` nor decided — so every surface that asks this question would have
 * answered *nothing to decide* for a plan the system had just flagged, hiding
 * the rail that states why it cannot be approved and the Decline that is one of
 * its only two exits. Whether the reviewer can still ACT is a separate question,
 * answered per control by `PlanReviewRail` (Approve is disabled, Decline is
 * not); this one is only *is a person still holding this?*.
 *
 * ⚠️ NOTE FOR THE READER OF AMENDMENT 9 D6: this file is NOT in that table's
 * list of surfaces a `PlanStatus` member obliges, and it should have been — it
 * was found by a test going red, not by the enumeration. It is the same shape as
 * `staleCountFor` and `computePlanStaleness`: a `planned` check standing in for
 * *undecided*, which a fifth status is exactly what pulls apart.
 */
export async function readPendingProposal(
  planId: string,
  signal?: AbortSignal,
): Promise<PlanReviewDto | null> {
  const review = await fetchPlanReview(planId, signal);
  const undecided = review.status === 'planned' || review.status === 'stale';
  return undecided && review.items.length > 0 ? review : null;
}

/**
 * A failed decision, as a stable copy key the surface can explain. The two a
 * reviewer can actually hit are named; everything else falls to the generic
 * recoverable line, so a raw server code never reaches the screen.
 *  • `PLAN_TARGET_IMMUTABLE` — the persist gate refused: a target reached
 *    done/cancelled under the proposal (nothing was written).
 *  • `PLAN_NOT_IN_EXPECTED_STATUS` / a 404 — someone (or another tab) already
 *    decided this plan, so there is nothing left to confirm.
 */
export function planDecisionErrorCode(err: unknown, fallback = 'APPROVE_ERROR'): string {
  if (!(err instanceof PlanRequestError)) return fallback;
  if (err.code === 'PLAN_TARGET_IMMUTABLE') return 'immutable';
  if (err.code === 'PLAN_NOT_IN_EXPECTED_STATUS' || err.status === 404) return 'decided';
  return fallback;
}

/** What an approve landed, so a surface can say it back. */
export interface PlanApproveSummary {
  created: string[];
  updated: string[];
  removed: string[];
}

/** Read the outcome off the plan `materialize` returned: its `add` items became
 *  work items, its `modify` items changed existing ones, its `remove` items took
 *  them away. (It replaces the delta route's `ApproveDeltaResult`, which named the
 *  same facts about a delta that was always empty.) */
export function summarizePlanApproval(plan: PlanWithItemsDto): PlanApproveSummary {
  const ids = (op: 'add' | 'modify' | 'remove') =>
    plan.items.filter((item) => item.op === op).map((item) => item.workItemId ?? item.id);
  return { created: ids('add'), updated: ids('modify'), removed: ids('remove') };
}
