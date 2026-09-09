// Typed errors for the approval-gate domain (Story MOTIR-4778 · Subtask
// MOTIR-4788; ADR docs/decisions/approval-gates.md). Kept in their own file so
// the service / route layers (the decide-door card MOTIR-4790, the Approvals
// tab) can import them without pulling in the Prisma client.
//
// This card ships the repository leaf and NO service: the unique-constraint
// race on the partial index `approval_gate_one_awaiting_per_subject` is
// translated HERE, at the repository's edge, so a raw Prisma `P2002` never
// escapes it — the same disposition `workItemLinkRepository` gives the
// `(fromId, toId, kind)` unique (→ `DuplicateLinkError`). The decide-door
// service catches the typed error and branches on it; it never inspects a raw
// Postgres / Prisma code (the 4-layer rule).
//
// Every class carries a string `tag` discriminant so the service layer can
// `switch (err.tag)` over an `ApprovalGateError` union exhaustively without
// `instanceof` chains. `code` mirrors `tag` and is what the route layer (the
// decide-door card) maps to an HTTP status. Mirrors the shape of
// `lib/workItems/linkErrors.ts`.

export type ApprovalGateErrorTag = 'APPROVAL_GATE_ALREADY_AWAITING';

/**
 * Base class for every approval-gate typed error. Concrete subclasses set a
 * literal `tag` (the discriminant) and a matching `code`.
 */
export abstract class ApprovalGateError extends Error {
  abstract readonly tag: ApprovalGateErrorTag;
  abstract readonly code: ApprovalGateErrorTag;
}

/**
 * An `awaiting` gate already exists for the same `(workItemId, kind, subjectId)`
 * — the partial unique index `approval_gate_one_awaiting_per_subject` refused a
 * second. Translated from Prisma `P2002` on that constraint, so a raw DB error
 * never escapes the repository.
 *
 * The decide-door card catches this and renders it in the control (a gate
 * somebody else decided while the row was on screen) rather than throwing —
 * the same shape the ADR §4 names for "a gate somebody else decided while the
 * row was on screen".
 *
 * ⚠️ Under `motir_app` (FORCE RLS, non-superuser) PostgreSQL declines to
 * describe the conflicting key, so the `P2002` carries no `meta.target` — the
 * repository does not inspect the target, only the code, for the same reason
 * `workItemLinkRepository` does not (the `(fromId, toId, kind)` unique is the
 * only one that can fire on that insert; the partial-unique here is the only
 * one that can fire on this one).
 */
export class ApprovalGateAlreadyAwaitingError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_ALREADY_AWAITING' as const;
  readonly code = 'APPROVAL_GATE_ALREADY_AWAITING' as const;
  constructor(
    message = 'An awaiting approval gate already exists for this subject — another decision is in flight.',
  ) {
    super(message);
    this.name = 'ApprovalGateAlreadyAwaitingError';
  }
}
