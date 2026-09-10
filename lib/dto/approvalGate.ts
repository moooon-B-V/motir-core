// Wire DTOs for the approval-gate record (Story MOTIR-4778 · Subtask
// MOTIR-4788; ADR docs/decisions/approval-gates.md). The service layer (the
// decide-door card MOTIR-4790, the Approvals tab MOTIR-4779) maps Prisma rows
// to these via `lib/mappers/approvalGateMappers.ts` just before returning
// (CLAUDE.md — services never return raw Prisma models). Dates are ISO strings,
// matching the work-items / acceptance-evidence DTO convention.
//
// BASE record (MOTIR-4788): the subject, the kind, the state, who decided it
// and when, and the note. ⚠️ THE AUDIT SET (MOTIR-4912) is now here — the
// immutable subject version, the surviving actor label, the routed-to, the
// permission, the source and the outcome — so this DTO carries the whole of ADR
// §6a rather than only its workflow half.
//
// Every audit field is NULLABLE on the wire because it is nullable in the
// column, and for the same reason: five are written by the DECISION and are null
// while the gate is `awaiting`; `routedToId` is written at creation and is null
// only when the gate was routed to nobody. A consumer therefore reads `state`
// first and the audit set second — a null here is *not yet decided*, never
// *decided by nobody*, which is exactly the confusion `decidedByLabel` exists to
// prevent (§6b's amendment).

/** Which vocabulary of decision verbs a gate carries (ADR §1). Mirrors the
 *  `ApprovalGateKind` Prisma enum as the wire string union a client consumes. */
export type ApprovalGateKindDTO =
  | 'design_result'
  | 'decision_approval'
  | 'pull_request_approval'
  | 'pull_request_merge';

/** Where a gate's decision stands (ADR §6b). Mirrors the `ApprovalGateState`
 *  Prisma enum. */
export type ApprovalGateStateDTO = 'awaiting' | 'approved' | 'changes_requested' | 'superseded';

/** Under which §2 authority rung the decision was made (ADR §6a). Mirrors the
 *  `ApprovalGateAuthority` Prisma enum. Frozen at decision time, so a reader can
 *  answer *"was this person entitled?"* without re-deriving a role that has
 *  since changed. */
export type ApprovalGateAuthorityDTO = 'assignee' | 'reporter' | 'admin';

/** Through which surface the decision arrived (ADR §6a, with `github` added by
 *  §6b's amendment). Mirrors the `ApprovalGateDecisionSource` Prisma enum. A
 *  human click, a token's API call, an agent's MCP call and a review synced out
 *  of GitHub are four different answers to *"was a human in the loop?"*. */
export type ApprovalGateDecisionSourceDTO = 'ui' | 'api' | 'mcp' | 'github';

/**
 * The two decision VERBS, as the wire carries them.
 *
 * ⚠️ IT LIVES HERE, NOT ON THE SERVICE, AND THE CLIENT/SERVER BOUNDARY IS WHY.
 * The approval frame is a `'use client'` module and this is part of its props,
 * so importing it from `@/lib/services/*` would make a client module import the
 * service layer — which `tests/planning/planChangeArchitecture.test.ts` refuses
 * repo-wide, and rightly: such an import compiles, survives SSR, and then fails
 * in the browser or bundles the DB client into the page. A type-only import is
 * erased at build time and would bundle nothing, but the guard reads the import
 * SITE rather than its erasure, and it is a better guard for doing so — the
 * remedy is to put the type where the wire vocabulary already lives, not to
 * teach the guard an exception.
 *
 * A kind may later carry a verb SET rather than this pair (ADR §1's amendment,
 * `decision_choice`), which is why the door takes a decision rather than
 * exposing `approve()` / `requestChanges()` as separate methods.
 */
export type GateDecision = 'approve' | 'request_changes';

/**
 * One approval gate, as the decide control / Approvals tab renders it. The
 * card the gate hangs off (`workItemId`) is the join every surface uses; the
 * `subjectId` is resolved per-`kind` by the registry handler (a `DesignEvidence`
 * id, a pull-request delivery id, …) and is opaque to the DTO.
 */
export interface ApprovalGateDTO {
  id: string;
  /** The card the gate hangs off. */
  workItemId: string;
  kind: ApprovalGateKindDTO;
  /** The row being decided — resolved by the registry handler for `kind`. */
  subjectId: string;
  state: ApprovalGateStateDTO;
  /** WHO decided. Null while `awaiting` / `superseded`. `SetNull` on the FK so a
   *  departing member loses attribution, never the record that a decision
   *  happened — read it beside `decidedByLabel`, which survives the deletion. */
  decidedById: string | null;
  /** ISO-8601, or null while `awaiting` / `superseded`. */
  decidedAt: string | null;
  /** Why they said yes, or what they sent back. Null while `awaiting`. */
  noteMd: string | null;

  // ── THE AUDIT SET (ADR §6a · MOTIR-4912) ─────────────────────────────────
  /** WHAT was approved, immutably: the subject's version at decision time — a
   *  design's `commitSha`, a pull request's `headSha`. The record says the
   *  decider approved *these bytes* rather than *a design*, which is the
   *  difference between evidence and a name with a date beside it. Opaque, like
   *  `subjectId`: its shape depends on the kind. */
  subjectVersion: string | null;
  /** WHO decided, surviving their departure — their name and email as at the
   *  decision, or a GitHub login for a synced review whose identity resolves to
   *  no member. When `decidedById` is null and this is not, the answer is *"a
   *  person we can name but no longer resolve"*; when BOTH are null on a decided
   *  gate, the record is incomplete rather than anonymous. */
  decidedByLabel: string | null;
  /** WHO the gate was routed to when it was created (§2). The card's assignee
   *  can change afterwards, so this is the only record of who was actually
   *  asked. Null when the gate was routed to nobody. No surviving label — the
   *  routing is context, not the attribution the audit rests on. */
  routedToId: string | null;
  /** UNDER WHICH permission the decider acted. Null while `awaiting`. */
  decidedUnderAuthority: ApprovalGateAuthorityDTO | null;
  /** THROUGH WHICH surface the decision arrived. Null while `awaiting`. */
  decisionSource: ApprovalGateDecisionSourceDTO | null;
  /** WHAT it caused — the merge commit sha, or the transition applied. Written
   *  in the deciding write, never backfilled: a decided gate is immutable. */
  outcomeRef: string | null;

  createdAt: string;
  updatedAt: string;
}
