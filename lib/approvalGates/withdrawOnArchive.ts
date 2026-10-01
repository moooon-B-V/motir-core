import type { Prisma } from '@/generated/prisma/client';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';

// ARCHIVING A CARD WITHDRAWS EVERY QUESTION STILL WAITING ON IT (MOTIR-7109).
//
// Archive is the "nobody will finish this" act, and it is NOT a status transition, so
// it never reaches `applyStatusTransition` and the pull-back rule there (ADR
// `approval-gates.md` §6d AMENDMENT, rule 6) never sees it. Before this, an archived
// card kept its `awaiting` gates: still listed on To approve, still marked on the
// board, and still approvable — an approval that writes a status and merges pull
// requests for work a person had just taken off the board.
//
// Every kind alike, through the all-kinds supersede: a per-kind list would leave the
// next registered kind awaiting on an archived card. The cause is `pulled_back`, the
// one the funnel writes for a move to Cancelled — archive abandons the work the same
// way. Unarchiving does NOT bring the question back: entering review again raises a
// fresh gate through the re-ask seam (MOTIR-5532).
//
// ⚠️ CALL IT BEFORE THE CARD'S ROW IS WRITTEN OR LOCKED. The decide door locks its gate
// and then transitions the card, so the gates are locked first here too — the funnel's
// rule 8 lock order. Taking them after the card would deadlock against an approval
// pressed at the same moment.

/** Lock and withdraw every `awaiting` gate on a work item about to be archived.
 *  Returns how many questions were withdrawn. */
export async function withdrawQuestionsOnArchive(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const awaiting = await approvalGateRepository.lockAwaitingByWorkItem(workItemId, tx);
  if (awaiting.length === 0) return 0;
  return approvalGateRepository.supersedeAllAwaitingByWorkItem(workItemId, 'pulled_back', tx);
}
