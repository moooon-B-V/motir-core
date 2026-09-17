import type { DeliverySetMember } from '@/lib/approvalGates/reviewVerdict';

// THE SEAM BETWEEN A SYNCED DECISION AND THE MERGE IT CAUSES (Story MOTIR-4910;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 6).
//
// ⚠️ A SEPARATE MODULE, AND A SEPARATE STEP, FOR THE REASON THE PRESS HAS ONE
// (MOTIR-5483): a merge writes to somebody else's repository, and that must not happen
// inside the transaction that decides the gate. The decision commits FIRST; the merge runs
// after, per member, and a host refusal on one member leaves the approval standing.
//
// ⚠️ THIS BODY IS MOTIR-5608'S TO FILL. MOTIR-5597 ships the evaluator that CALLS it — with
// the seam asserted, so the hand-off is proven to happen exactly once on an approval and not
// at all on any other verdict — and MOTIR-5608 replaces the no-op with the press's own
// merge-or-enqueue path. It is declared here rather than inlined so the two cards do not
// have to land in one commit, and so the call site is a real, spied-upon boundary rather
// than a promise in a comment.

/** What a synced approval hands the merge step. */
export interface SyncedMergeRequest {
  /** The gate the review decided — the card's ONE approve-to-merge gate. */
  gateId: string;
  workItemId: string;
  workspaceId: string;
  /** Who Motir will act as for the merge: the resolved member, else the workspace owner. */
  actorUserId: string;
  /** Every member of the approved set, at the heads the gate named. */
  members: readonly DeliverySetMember[];
}

/**
 * Merge, or enqueue, every member of a set a GitHub review just approved.
 *
 * ⚠️ NO-OP UNTIL MOTIR-5608. It returns without doing anything, which is the honest state of
 * the feature on this commit: the decision is recorded and the card reads Approved, and the
 * merge is the next card. It must NEVER throw — a failure here cannot unwind a decision that
 * has already committed.
 */
export async function runSyncedMerge(_request: SyncedMergeRequest): Promise<void> {
  // MOTIR-5608 fills this in: the same merge-or-enqueue path an *Approve and merge* press
  // runs, per member, recording each outcome on its own pull request.
  return;
}
