import type { ApprovalGateKindDTO, PendingDecisionDTO } from '@/lib/dto/approvalGate';
import { routingTargetId } from '@/lib/approvalGates/routing';

/**
 * One awaiting gate as the marker needs it — STRUCTURAL, so the repository's
 * projection satisfies it and a unit test can build one without a database.
 */
export interface AwaitingGateForMarker {
  workItemId: string;
  kind: ApprovalGateKindDTO;
  createdAt: Date;
  workItem: { assigneeId: string | null; reporterId: string | null };
}

/**
 * Fold a set of awaiting gates into ONE marker entry per work item (Story
 * MOTIR-4908 · MOTIR-5876).
 *
 * **Yours** is §2's routing rule plus the kind's permission floor — the two tests
 * the To-approve tab's row applies before it offers a press. The routing half is
 * `routingTargetId`, never a re-spelling of `assigneeId ?? reporterId`, so the
 * marker and the tab cannot disagree about who a gate is routed to. The floor
 * half is the caller's `holdsFloor`, answered from ONE permission read.
 *
 * **Precedence**: any `yours` gate makes the card yours, because a card that owes
 * you a press must say so however many other questions it carries. Among several,
 * the OLDEST is the entry — its `kind` is what the item header jumps to, and the
 * oldest is what the tab lists first. With no `yours` gate, the oldest `others`.
 *
 * ⚠️ The input must arrive oldest-first (the repository orders it so); the fold
 * keeps the first match per card rather than re-sorting.
 */
export function foldPendingDecisions(
  gates: readonly AwaitingGateForMarker[],
  readerId: string,
  holdsFloor: (kind: ApprovalGateKindDTO) => boolean,
): Map<string, PendingDecisionDTO> {
  const out = new Map<string, PendingDecisionDTO>();
  for (const gate of gates) {
    const routedToId = routingTargetId(gate.workItem);
    const state = routedToId === readerId && holdsFloor(gate.kind) ? 'yours' : 'others';
    const current = out.get(gate.workItemId);
    // Keep the first gate seen, except that a first `yours` displaces an `others`.
    if (current && (current.state === 'yours' || state === 'others')) continue;
    out.set(gate.workItemId, { state, kind: gate.kind, routedToId });
  }
  return out;
}
