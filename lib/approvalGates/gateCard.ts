import { ApprovalGateHasNoCardError } from './errors';

// THE CARD OF A GATE, for a path that is only ever handed a card-bearing kind
// (Story MOTIR-6012 · MOTIR-6032; ADR `approval-gates.md` §11.1).
//
// `ApprovalGate.workItemId` is nullable since the plan gate: NULL ⟺ `kind =
// plan_approval`, held at the database by `approval_gate_work_item_iff_not_plan`.
// Every kind registered before it ALWAYS carries a card, so the handlers, reads and
// routes written for them narrow here rather than each inventing a fallback.
//
// ⚠️ A CALL HERE IS A CLAIM THAT THE PATH NEVER MEETS A PLAN GATE. MOTIR-6034 is the
// card that teaches the shared reads (the decide door's pre-read, the queue, the
// record reads, the DTO) to handle a card-less gate properly; `git grep
// requireGateCard` is its worklist, and each site it converts stops calling this.

/**
 * The gate's work-item id, or {@link ApprovalGateHasNoCardError} naming `where`.
 * Never a fallback value: a card-less gate on a card path is a defect, and a
 * guessed id would write somebody else's card.
 */
export function requireGateCard(
  gate: { id: string; kind?: string; workItemId: string | null },
  where: string,
): string {
  if (gate.workItemId === null)
    throw new ApprovalGateHasNoCardError(gate.id, gate.kind ?? 'unknown', where);
  return gate.workItemId;
}

/**
 * The gate's JOINED work-item row, for a read that selected it — the same claim as
 * {@link requireGateCard}, over the relation rather than the id.
 */
export function requireGateWorkItem<T>(
  gate: { id: string; kind?: string; workItem: T | null },
  where: string,
): T {
  if (gate.workItem === null)
    throw new ApprovalGateHasNoCardError(gate.id, gate.kind ?? 'unknown', where);
  return gate.workItem;
}

/**
 * The CARD a handler's routing / effect args carry, for a handler of a card-bearing
 * kind (MOTIR-6034). `GateRoutingArgs.item` is nullable so a card-less kind's handler
 * can be written against the same args (ADR §11.1); every other kind is always handed
 * its card by the door and the raisers, and narrows here rather than inventing a
 * fallback — a guessed card would route or write somebody else's work item.
 */
export function requireArgsCard<T>(
  args: { item: T | null; gate?: { id: string } },
  kind: string,
  where: string,
): T {
  if (args.item === null)
    throw new ApprovalGateHasNoCardError(args.gate?.id ?? '(not yet raised)', kind, where);
  return args.item;
}
