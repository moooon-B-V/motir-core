import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import { adminDb } from './adminDb';

// DECIDE A STORY'S ACCEPTANCE THE WAY THE PRODUCT DOES NOW (MOTIR-4950).
//
// `acceptanceEvidenceService.decide` is retired: a receipt is decided as the story's
// `acceptance_result` approval gate, through `approvalGatesService.decide` — the one
// door every gate kind uses. This helper presses the story's AWAITING acceptance gate
// through that door and answers in the shape the old call returned, so a suite that
// was about the RECEIPT (the freeze, the supersede, the board flag) keeps asserting
// that, and does not re-derive the gate plumbing in every file.
//
// ⚠️ THE GATE IS READ FIRST, THEN DECIDED — exactly what a reader does: they are shown
// a question, then press it. A publish that commits between the two supersedes the
// question, and the decide is then REFUSED as superseded (§6a: a gate asks about
// specific bytes). That is the gate model, and a race test must accept it.
export async function decideAcceptance(
  workItemId: string,
  decision: 'approve' | 'request_changes',
  ctx: { userId: string; workspaceId: string },
): Promise<{ evidence: AcceptanceEvidenceDTO; storyStatus: string }> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId, kind: 'acceptance_result', state: 'awaiting' },
  });
  await approvalGatesService.decide(
    { gateId: gate.id, decision, noteMd: null, source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
    ctx,
  );
  const evidence = await acceptanceEvidenceService.getForGateSubject(
    { workItemId, subjectId: gate.subjectId },
    ctx,
  );
  const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return { evidence: evidence!, storyStatus: story.status };
}
