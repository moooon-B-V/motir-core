import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { resolveStatusIntent, type StatusIntent } from '@/lib/workflows/statusIntent';

// WHICH STATUS MOVES AN APPROVAL HOLDS — the ONE statement of the rule the guard
// enforces and the status control draws (Story MOTIR-4887 · MOTIR-5526 / MOTIR-5528;
// ADR `docs/decisions/approval-gates.md` §6d AMENDMENT, rules 1–5 and 2b).
//
// ⚠️ PURE, AND SHARED ON PURPOSE. `workItemsService.applyStatusTransition` refuses
// a move with it, and `approvalGatesService.listHeldTransitions` tells the item
// page, quick view and edit page which moves to lock BEFORE anyone tries one. Two
// copies of this rule would disagree the first time either changed — the control
// would offer a move the door refuses, or lock one it allows — so both callers read
// their own inputs (inside or outside a lock) and hand them to this function.
//
// The rule, in the order it is applied:
//   · RULE 2b — "it's about if there's a PR" (Yue, 2026-09-14). With an OPEN
//     delivering pull request, `approved` is written only by the approval (so it
//     is held, waiting on the DECISION, unless this move IS that approval) and
//     every done-category status but Cancelled is written only by the merge (held,
//     waiting on the MERGE).
//   · RULE 1 — an `awaiting` gate holds the status its kind's intent resolves to
//     in this project, waiting on the decision. The deciding gate does not hold
//     its own write.

/** The pull-request gate kind a card with a pull request is decided by (§1's
 *  amendment) — named when a move is held before any gate row has been raised. */
export const PULL_REQUEST_GATE_KIND = 'pull_request_approval';
/** The status only an approve-to-merge approval writes. */
export const APPROVED_STATUS_KEY = 'approved';
/** The done-category status that means ABANDONED — never held. */
export const CANCELLED_STATUS_KEY = 'cancelled';

export interface HeldMove {
  statusKey: string;
  waitingOn: 'decision' | 'merge';
  /** The awaiting gate being waited on; null while a pull request is open and no
   *  gate has been raised yet (its checks are not green). */
  gateId: string | null;
  gateKind: string;
}

export function heldMoves(args: {
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>;
  hasOpenPullRequest: boolean;
  awaitingGates: ReadonlyArray<{ id: string; kind: string }>;
  /** The gate kind's status intent — null for a kind this build does not
   *  register, or one that owns no status. */
  intentOf: (kind: string) => StatusIntent | null;
  /** The gate whose OWN decision is making the move being checked, if any. */
  decidingGateId?: string;
}): HeldMove[] {
  const held: HeldMove[] = [];
  const gates = args.awaitingGates.filter((g) => g.id !== args.decidingGateId);

  if (args.hasOpenPullRequest) {
    const waitedOn = gates[0] ?? null;
    const gateId = waitedOn?.id ?? null;
    const gateKind = waitedOn?.kind ?? PULL_REQUEST_GATE_KIND;
    if (!args.decidingGateId && args.statuses.some((s) => s.key === APPROVED_STATUS_KEY)) {
      held.push({ statusKey: APPROVED_STATUS_KEY, waitingOn: 'decision', gateId, gateKind });
    }
    for (const status of args.statuses) {
      if (status.category === 'done' && status.key !== CANCELLED_STATUS_KEY) {
        held.push({ statusKey: status.key, waitingOn: 'merge', gateId, gateKind });
      }
    }
  }

  for (const gate of gates) {
    const intent = args.intentOf(gate.kind);
    if (!intent) continue;
    const statusKey = resolveStatusIntent(args.statuses, intent);
    if (!statusKey || held.some((h) => h.statusKey === statusKey)) continue;
    held.push({ statusKey, waitingOn: 'decision', gateId: gate.id, gateKind: gate.kind });
  }

  return held;
}
