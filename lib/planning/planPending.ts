import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';

// IS THERE A PROPOSAL NOBODY HAS DECIDED? (MOTIR-4731, under story MOTIR-4725)
//
// ONE definition, two readers, and that is the whole reason this file exists.
// `PlanningWorkspaceHost` has always used this expression to choose between the
// confirm-to-persist bar and the resting footer; the close-with-pending guard
// asks the identical question a beat later, and a second copy of it is how the
// bar and the guard end up disagreeing about whether anything is at stake.
//
// ⚠️ ALL THREE CLAUSES CARRY WEIGHT (MOTIR-3162). `state.review` alone is not it:
// a review SURVIVES its decision so the canvas can keep drawing what landed, so
// *there is a review* does not mean *there is a decision to take* — `decided` is
// what says that. And `index.isEmpty` covers the review that proposed nothing.
//
// The reader can see the rule, which is what makes the guard feel like a rule
// rather than a surprise: **if the bar is up, closing asks; if it is not,
// closing is instant.**

/** Is there an undecided, non-empty proposal on the canvas right now? */
export function isProposalPending(
  state: Pick<PlanChangeConversationState, 'review' | 'decided'>,
  index: Pick<PlanChangeDiffIndex, 'isEmpty'>,
): boolean {
  return Boolean(state.review) && !state.decided && !index.isEmpty;
}

/**
 * How many work items the pending proposal touches — the number the guard puts
 * in its copy, because *"discard the proposals"* and *"discard 5 work items you
 * just watched appear"* are different sentences.
 *
 * The same three counts the confirm bar names, summed: an add, a change and a
 * removal are each one thing the reader would lose.
 */
export function pendingProposalCount(index: Pick<PlanChangeDiffIndex, 'counts'>): number {
  return index.counts.added + index.counts.changed + index.counts.removed;
}
