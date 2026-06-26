import type { ValidityCondition } from '@/lib/dto/sprints';

// Shared finishability plumbing for the two validators — `validate_sprint`
// (Subtask 7.8.22) and `validate_work_item` (Subtask 7.8.23). Both ask the SAME
// question of every gating item (a `blocked_by` edge, or — for the sprint — a
// not-done child): is it satisfied? The only thing that varies is the
// "containing set" (the sprint's members vs the target's subtree) and how strict
// to be about a `done` item OUTSIDE that set. The predicate below is that single
// rule, factored so neither engine re-implements it.

/**
 * Is a gating item SATISFIED for finishability?
 *
 * - `inSet` — the gating item is IN the containing set (an in-sprint member, or
 *   a descendant of the validated work item). An in-set item ALWAYS satisfies:
 *   it is part of the work the set encompasses.
 * - otherwise it satisfies ONLY when it is `done` AND `condition === 'loose'`.
 *   Under `tight`, a `done` item outside the set does NOT satisfy (the set must
 *   be self-contained); a not-done item outside the set never satisfies.
 */
export function gatingItemSatisfied(
  inSet: boolean,
  blockerIsDone: boolean,
  condition: ValidityCondition,
): boolean {
  return inSet || (blockerIsDone && condition === 'loose');
}
