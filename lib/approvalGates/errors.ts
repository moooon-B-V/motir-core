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
// ⚠️ MOTIR-4790 (the DECIDE door) adds the five refusals the door itself raises
// — not found, already decided, superseded, not authorised, and an unregistered
// kind. The paragraph above still describes where the AWAITING-race translation
// lives, which is unchanged: that one is the REPOSITORY's, because it is a raw
// `P2002` that must not escape its edge. The five below are the SERVICE's,
// because each is a business rule the door applies rather than a database error
// it survives.
//
// ⚠️ AND MOTIR-4912 (the AUDIT columns) adds the file's SECOND repository-tier
// refusal, which is what makes that split worth reading carefully rather than as
// a one-off: `ApprovalGateDecidedImmutableError`, translated from the
// `trg_approval_gate_decided_immutable` BEFORE UPDATE trigger. So this file now
// holds errors from BOTH tiers, and the discriminator is whether a DATABASE
// refused the write or a RULE refused the request:
//
//   * REPOSITORY tier — `ApprovalGateAlreadyAwaitingError` (a `P2002` on the
//     partial unique) and `ApprovalGateDecidedImmutableError` (the immutability
//     trigger). Both are raw Postgres failures that must not escape, and both
//     are produced in ONE place: `translateApprovalGateWriteError` in
//     `approvalGateRepository`. Nothing else constructs them.
//   * SERVICE tier — the five below. The door applies each before it writes.
//
// ⚠️ `ApprovalGateAlreadyDecidedError` and `ApprovalGateDecidedImmutableError`
// are about the same FACT and are NOT interchangeable, which is the one confusion
// this list invites. The first is the door's EXPECTED refusal — a reviewer
// pressing a button somebody else already pressed, a 409 the control draws in
// place, raised with the row lock held and before any write is attempted. The
// second means that check was absent, bypassed or wrong and the database caught
// what the business rule was supposed to: a 500 and a finding, not a state the
// UI renders. Mapping them to the same status would hide the second behind the
// first for ever.
//
// Every class carries a string `tag` discriminant so the service layer can
// `switch (err.tag)` over an `ApprovalGateError` union exhaustively without
// `instanceof` chains. `code` mirrors `tag` and is what the route layer (the
// decide-door card) maps to an HTTP status. Mirrors the shape of
// `lib/workItems/linkErrors.ts`.

export type ApprovalGateErrorTag =
  // REPOSITORY tier — a database refused the write.
  | 'APPROVAL_GATE_ALREADY_AWAITING'
  | 'APPROVAL_GATE_DECIDED_IMMUTABLE'
  // SERVICE tier — the decide door refused the request.
  | 'APPROVAL_GATE_NOT_FOUND'
  | 'APPROVAL_GATE_ALREADY_DECIDED'
  | 'APPROVAL_GATE_SUPERSEDED'
  | 'APPROVAL_GATE_NOT_AUTHORISED'
  | 'APPROVAL_GATE_KIND_UNREGISTERED';

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

/**
 * An UPDATE was attempted on a gate that has already been DECIDED (`approved`
 * or `changes_requested`). The `approval_gate` BEFORE UPDATE trigger
 * `trg_approval_gate_decided_immutable` refused it; this is that refusal,
 * translated at the repository's edge so a raw Postgres error never escapes it
 * (Subtask MOTIR-4912).
 *
 * ADR §6a: *"A decided gate is IMMUTABLE. There is no update path for a decided
 * row — audit evidence that can be edited is not evidence."* So this is NOT a
 * transient condition to retry and NOT a conflict to resolve — there is no
 * version of the write that succeeds.
 *
 * ⚠️ IT IS NOT {@link ApprovalGateAlreadyAwaitingError}'S COUSIN, AND IT IS NOT
 * THE DECIDE DOOR'S *already decided* REFUSAL EITHER. The door's own refusal is
 * the normal, EXPECTED path for a reviewer who pressed a button somebody else
 * had already pressed — a 409 the control draws in place, reached with the row
 * lock held and before any write is attempted. Reaching THIS error means the
 * service's check was absent, bypassed, or wrong, and the database caught what
 * the business rule was supposed to: a `500` rather than a rendered message, and
 * a finding rather than a state.
 *
 * The state and the decision moment come off `OLD` in the trigger's message, so
 * the refusal says WHICH decision it is protecting rather than only that one
 * exists — the same reason the door's refusal names the winner.
 */
export class ApprovalGateDecidedImmutableError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_DECIDED_IMMUTABLE' as const;
  readonly code = 'APPROVAL_GATE_DECIDED_IMMUTABLE' as const;
  constructor(
    message = 'This approval gate has already been decided and cannot be changed — a decided gate is immutable audit evidence.',
  ) {
    super(message);
    this.name = 'ApprovalGateDecidedImmutableError';
  }
}

/**
 * The gate id names no gate this actor can see — missing, or in another
 * workspace (RLS hides it, so the two are indistinguishable here, which is the
 * no-existence-leak posture the rest of the product keeps).
 */
export class ApprovalGateNotFoundError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_NOT_FOUND' as const;
  readonly code = 'APPROVAL_GATE_NOT_FOUND' as const;
  constructor(readonly gateId: string) {
    super(`No approval gate ${gateId}.`);
    this.name = 'ApprovalGateNotFoundError';
  }
}

/**
 * The gate is `approved` or `changes_requested` — somebody already decided it.
 * The ADR calls this `GateAlreadyDecidedError` (§ the decide door's step 3); the
 * class carries the file's `ApprovalGate*` prefix and the shorthand is the same
 * error.
 *
 * It NAMES the winner and the moment, because the surface's job is to say so in
 * place rather than to fail generically — ADR §4's *"a gate somebody else
 * decided while the row was on screen"* is one of the enumerated refusals the
 * control draws, and it cannot draw it from a bare 409.
 *
 * ⚠️ `decidedById` is NULLABLE even here. The FK is `onDelete: SetNull`, so a
 * decision whose actor has since left the workspace keeps the record that it
 * happened and loses the attribution — the audit column that survives a
 * departure is a sibling card's (MOTIR-4912). A null therefore means *we no
 * longer know who*, never *nobody decided it*.
 */
export class ApprovalGateAlreadyDecidedError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_ALREADY_DECIDED' as const;
  readonly code = 'APPROVAL_GATE_ALREADY_DECIDED' as const;
  constructor(
    readonly gateId: string,
    readonly state: 'approved' | 'changes_requested',
    readonly decidedById: string | null,
    readonly decidedAt: Date | null,
  ) {
    super(
      `Approval gate ${gateId} was already decided (${state})${
        decidedAt ? ` at ${decidedAt.toISOString()}` : ''
      }.`,
    );
    this.name = 'ApprovalGateAlreadyDecidedError';
  }
}

/**
 * The gate's SUBJECT was superseded, so the question was WITHDRAWN — a newer
 * design result is current and this gate asks about a version the product has
 * moved past (ADR §6b).
 *
 * A SEPARATE error from {@link ApprovalGateAlreadyDecidedError} on purpose, and
 * the separation is the same one §6b makes in the state set: `superseded` is
 * **not a decision**. It carries no actor, no permission and no note, so
 * collapsing the two refusals would make the surface say *"somebody already
 * decided this"* about a question nobody answered — which is precisely the
 * sentence the audit must never be able to produce.
 *
 * ⚠️ Nothing WRITES `superseded` yet: the supersede predicate and the retirement
 * of a prior awaiting gate are MOTIR-4913's, `blocked_by` this card. The refusal
 * ships here regardless, because the state is in the Prisma enum today and a
 * door that is total over its kinds owes the same totality over its states — the
 * alternative is a row this door would fall through and decide.
 */
export class ApprovalGateSupersededError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_SUPERSEDED' as const;
  readonly code = 'APPROVAL_GATE_SUPERSEDED' as const;
  constructor(readonly gateId: string) {
    super(
      `Approval gate ${gateId} was superseded — a newer version of its subject has been published, so this question has been withdrawn.`,
    );
    this.name = 'ApprovalGateSupersededError';
  }
}

/**
 * The actor may edit the project but holds no RELATIONSHIP to the work item —
 * they are neither its assignee nor its reporter, and they are not a workspace
 * owner/admin.
 *
 * ADR §2's amendment: **AUTHORITY is assignee OR reporter OR admin**, for both
 * verbs, applied ON TOP of the kind's permission floor rather than instead of
 * it. It is deliberately NOT the routing rule — a gate is SHOWN to one person
 * (`assigneeId ?? reporterId`) and may be PRESSED by three — so this error is
 * reachable by someone who can see the gate perfectly well.
 */
export class ApprovalGateNotAuthorisedError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_NOT_AUTHORISED' as const;
  readonly code = 'APPROVAL_GATE_NOT_AUTHORISED' as const;
  constructor(readonly gateId: string) {
    super(
      `Only the work item's assignee, its reporter, or a workspace admin may decide approval gate ${gateId}.`,
    );
    this.name = 'ApprovalGateNotAuthorisedError';
  }
}

/**
 * The gate's KIND has no handler in this build — one of the registry's
 * deliberate compile-time holes (`lib/approvalGates/registry.ts`).
 *
 * Unreachable through the product today: nothing CREATES a gate of an
 * unregistered kind, because the only writer is the design-result publish. It
 * exists so the door's dispatch is total at RUNTIME as well as at compile time —
 * a row written by a migration, a fixture, or a half-landed future card meets a
 * named refusal instead of an `undefined` handler and a `TypeError`.
 */
export class ApprovalGateKindUnregisteredError extends ApprovalGateError {
  readonly tag = 'APPROVAL_GATE_KIND_UNREGISTERED' as const;
  readonly code = 'APPROVAL_GATE_KIND_UNREGISTERED' as const;
  constructor(readonly kind: string) {
    super(`No approval-gate handler is registered for kind \`${kind}\` in this build.`);
    this.name = 'ApprovalGateKindUnregisteredError';
  }
}
