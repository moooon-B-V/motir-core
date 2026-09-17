import type { DeliverySetMember } from '@/lib/approvalGates/reviewVerdict';
import { mergeApprovedSetMembers } from './pullRequestMergeService';

// THE MERGE A SYNCED APPROVAL CAUSES (Story MOTIR-4910 · MOTIR-5608;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 6).
//
// ⚠️ A SEPARATE STEP, FOR THE REASON THE PRESS HAS ONE (MOTIR-5483): a merge writes to
// somebody else's repository, and that must not happen inside the transaction that decides
// the gate. The decision commits FIRST; this runs after, per member.
//
// ⚠️ IT ADDS A CALLER, NOT A PATH. The work is `pullRequestMergeService`'s own step 2 —
// `mergeApprovedSetMembers`, the same function an *Approve and merge* press runs — so the
// `expectedHeadSha` check, the refusal union and the `recordMotirMerge` outcome on each pull
// request are identical. A synced approval and a press differ in WHO decided and in nothing
// else, and that sentence is only true because this file calls rather than re-implements.
//
// ⚠️ AND IT NEVER THROWS. By the time it runs, a decision a reviewer made has committed and
// the card reads Approved. A throw here cannot unwind that, so it would only turn a partial
// merge into an unhandled rejection in a webhook handler. Each member already turns a host
// refusal into a RESULT; what this catches is the unexpected — and it logs the gate so the
// failure is findable, because the reader's next act is the frame's own *Retry merge*.

/** What a synced approval hands the merge step. */
export interface SyncedMergeRequest {
  /** The gate the review decided — the card's ONE approve-to-merge gate. */
  gateId: string;
  workItemId: string;
  workspaceId: string;
  /** Who Motir acts as for the merge: the resolved member, else the workspace owner. */
  actorUserId: string;
  /** Every member of the approved set, at the heads the gate named. */
  members: readonly DeliverySetMember[];
}

/**
 * Merge, or enqueue, every member of a set a GitHub review just approved.
 *
 * The members are re-derived from the gate's own `subjectVersion` inside
 * `mergeApprovedSetMembers`, so the caller's list is what it INTENDS rather than what is
 * merged — one reading of the set, held by the gate.
 */
export async function runSyncedMerge(request: SyncedMergeRequest): Promise<void> {
  const ctx = { userId: request.actorUserId, workspaceId: request.workspaceId };
  const subjectVersion = request.members.map((member) => member.subjectVersion).join(',');

  try {
    const outcomes = await mergeApprovedSetMembers(request.gateId, subjectVersion, ctx);
    const refused = outcomes.filter((outcome) => outcome.outcome === 'refused');
    if (refused.length > 0) {
      // Not a failure of the decision — the approval stands and each refused member is
      // retried from the Development frame. Logged so a host refusing every merge is
      // visible without reading the rows one by one.
      console.warn('[syncedMergeRunner] a member was refused by the host', {
        gateId: request.gateId,
        workItemId: request.workItemId,
        refused: refused.map((outcome) => outcome.subjectVersion),
      });
    }
  } catch (err) {
    console.warn('[syncedMergeRunner] the merge after a synced approval failed', {
      gateId: request.gateId,
      workItemId: request.workItemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
