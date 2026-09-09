// Wire DTOs for the approval-gate record (Story MOTIR-4778 · Subtask
// MOTIR-4788; ADR docs/decisions/approval-gates.md). The service layer (the
// decide-door card MOTIR-4790, the Approvals tab MOTIR-4779) maps Prisma rows
// to these via `lib/mappers/approvalGateMappers.ts` just before returning
// (CLAUDE.md — services never return raw Prisma models). Dates are ISO strings,
// matching the work-items / acceptance-evidence DTO convention.
//
// BASE record (MOTIR-4788): the subject, the kind, the state, who decided it
// and when, and the note. The AUDIT columns (the immutable subject version,
// the surviving actor label, the routed-to, the permission, the source, the
// outcome) land in a sibling `blocked_by` this card and widen this DTO there.

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
   *  happened. */
  decidedById: string | null;
  /** ISO-8601, or null while `awaiting` / `superseded`. */
  decidedAt: string | null;
  /** Why they said yes, or what they sent back. Null while `awaiting`. */
  noteMd: string | null;
  createdAt: string;
  updatedAt: string;
}
