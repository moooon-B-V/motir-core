import type { ApprovalGate, Prisma } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { standingMergeRefusalOf } from '@/lib/workItems/fixReason';

// A CODE REVIEW SENT BACK, STILL STANDING (Story MOTIR-1626 · MOTIR-6822;
// `approval-gates.md` §12.4 and §12.7).
//
// A card is SENT BACK when a review of its delivery set asked for changes — the review
// agent's `changes_requested` on `agent_review`, or a person's *Request changes* on the
// approve-and-merge gate — and nothing has answered it yet. Two readers ask this, and
// both read THIS function so they cannot drift:
//
//   · the REPAIR claim — a standing refusal is the `review` repair class, served by
//     `motir fix <KEY>` even though the card's checks are green;
//   · the To fix column — the same refusal derives `changes_requested`
//     (`fixReasonService`), whose repair is `fix` for both gate kinds.
//
// The RULE is `standingMergeRefusalOf`'s — the card's latest DECIDED gate of any kind,
// a refusal on one of the two review kinds, about the members' CURRENT heads. A push is
// the answer to a refusal: it moves a head, the version no longer matches, and from that
// commit on the card waits on CI (and, with the switch on, on a fresh review).

/** A standing review refusal — the gate the reviewer decided, and the version it is about. */
export type StandingReviewRefusal = ApprovalGate & {
  kind: 'agent_review' | 'pull_request_approval';
};

/**
 * The card's standing review refusal, or null. `deliveries` is the card's WHOLE delivery
 * set (merged and closed rows included) as `listByWorkItemWithChecks` reads it — the set
 * whose version the refusal was stamped with.
 */
export async function readStandingReviewRefusal(
  workItemId: string,
  deliveries: readonly WorkItemDeliveryWithChecks[],
  tx: Prisma.TransactionClient,
): Promise<StandingReviewRefusal | null> {
  const latest = await approvalGateRepository.findLatestDecidedByWorkItem(workItemId, tx);
  const currentVersion = deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d)));
  return latest && standingMergeRefusalOf(latest, currentVersion)
    ? (latest as StandingReviewRefusal)
    : null;
}
