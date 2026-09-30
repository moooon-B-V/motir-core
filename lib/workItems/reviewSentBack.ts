import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';

/**
 * A card a REVIEW sent back, repaired by `motir fix` (Story MOTIR-1626 · MOTIR-6930;
 * `approval-gates.md` §12.4b): To fix `changes_requested` on the review agent's gate or
 * a person's Request changes on the approve-and-merge gate. It is the ONLY To fix reason
 * *Fix on the hosted agent* is offered for (§12.9) — never red CI, a merge-queue failure,
 * a conflict, an acceptance Re-run or a dead run — so every surface that places the door
 * asks this one question, and the server's `hosted_fix_not_sent_back` is the same rule.
 */
export function isReviewSentBack(
  fixReason: WorkItemFixReasonDto | null,
  fixDetail: FixDetailDto | null,
): boolean {
  return (
    fixReason === 'changes_requested' &&
    fixDetail?.repair === 'fix' &&
    (fixDetail.gate === 'agent_review' || fixDetail.gate === 'pull_request_approval')
  );
}
