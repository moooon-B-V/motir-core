import type { Prisma } from '@/generated/prisma/client';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';

// WHICH GATES OFFER A REFUSAL VERDICT (Story MOTIR-6071 · MOTIR-6501;
// `docs/decisions/acceptance-refusal-verdict.md` §1 and §6, amending ADR
// `approval-gates.md` §10d).
//
// A verdict — `revise` / `re_plan` — used to be offered by exactly one KIND
// (`design_result`, MOTIR-6421), so a constant answered it. An `acceptance_result`
// gate now offers one too, but only on a STORY RUN: the story has an open delivery
// of its own, so the work exists and can be re-run or re-planned. A FINISHED story
// (every subtask merged, no delivery of its own) has nothing left to re-run, so its
// refusal takes a reason only. The answer therefore depends on DATA, not only on the
// kind, which is why it is a function the decide door calls under its lock.
//
// ⚠️ IT ANSWERS FOR A PRESS IN MOTIR. The source rule (`github` is never offered a
// verdict, because nobody on GitHub was asked) stays in the decide door, beside the
// reason rule it mirrors. What this module answers is whether THIS gate asks the
// question at all — the one fact the door, the gate DTO and the refusal band read.

/**
 * Whether a work item has an open delivery of its OWN — the RUN SHAPE of the story
 * an acceptance gate is about (`acceptance-refusal-verdict.md` §1). One read, shared
 * by the verdict offer and `acceptanceResultHandler`'s `nothingLeftForTheCascade`, so
 * the door that asks for a verdict and the handler that decides who writes `done`
 * never disagree about which shape the story is.
 */
export async function hasOpenOwnDelivery(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  return (await workItemDeliveryRepository.countOpenByWorkItem(workItemId, tx)) > 0;
}

/**
 * Whether a `request_changes` on this gate is offered a VERDICT — and, for a press in
 * Motir, REQUIRES one. TOTAL over {@link ApprovalGateKindDTO}: the exhaustive switch's
 * `never` arm fails the type-check the day a kind is added without an answer, so a new
 * kind is a compile error rather than a silent *not offered*.
 */
export async function refusalVerdictOfferFor(
  gate: { kind: ApprovalGateKindDTO; workItemId: string | null },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  switch (gate.kind) {
    case 'design_result':
      return true;
    case 'acceptance_result':
      // A story run — its own pull requests are open — takes Re-run / Re-plan; a
      // finished story takes a reason only (§6).
      return gate.workItemId !== null && (await hasOpenOwnDelivery(gate.workItemId, tx));
    case 'decision_approval':
    case 'pull_request_approval':
    case 'pull_request_merge':
    case 'decision_choice':
    case 'decision_confirmation':
    case 'plan_approval':
      return false;
    default: {
      const unhandled: never = gate.kind;
      throw new Error(`refusalVerdictOfferFor: no answer for gate kind ${String(unhandled)}`);
    }
  }
}
