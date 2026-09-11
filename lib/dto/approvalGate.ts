import type { WorkItemKindDto, WorkItemTypeDto } from '@/lib/dto/workItems';

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

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVALS QUEUE (Story MOTIR-4879 · Subtask MOTIR-4791) — what the
// Workbench's *To approve* tab reads. A DIFFERENT shape from `ApprovalGateDTO`
// above, and the difference is the surface: the gate DTO answers *what is the
// record of this decision?* on a card a reader is already looking at, and these
// answer *what is waiting on me, and which one is it?* in a list of things the
// reader has not opened.
//
// ⚠️ THE AUDIT SET IS ABSENT HERE, and that is not an omission to fix later.
// Every row this read returns is `awaiting`, so all six audit fields are null on
// every one of them by construction — carrying them would be six columns of
// guaranteed nulls travelling to a surface with nothing to render them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH DESIGN is waiting, at row scale — enough to recognise the work without
 * opening it.
 *
 * `noteExcerpt` is a LEAD rather than the note: a design note runs to tens of
 * kilobytes and a row has one line. The whole text is on the card, which is
 * where a reader who wants it is going anyway.
 */
export interface DesignResultSubjectSummaryDTO {
  kind: 'design_result';
  /** The `DesignEvidence` row the gate asks about — these bytes, not "the design". */
  designEvidenceId: string;
  /** The card whose pull request produced this result (e.g. `MOTIR-2669`). */
  producedByKey: string | null;
  /** The commit those bytes are, when the publish had one. */
  commitSha: string | null;
  /** How many files the result carries — the row says the number and links away. */
  assetCount: number;
  /** The first line or so of the design note, plain, or null when it has none. */
  noteExcerpt: string | null;
}

/**
 * A gate whose KIND THIS BUILD REGISTERS NO RENDERER FOR — a real row on the
 * day this ships, not a defensive branch.
 *
 * `lib/approvalGates/registry.ts` registers exactly one kind and names the other
 * three as declared compile-time holes owned by MOTIR-4907 / 4909 / 4910 / 4882.
 * A gate carrying one of them can exist — a fixture, a half-landed sibling, the
 * day the next story lands its creation path before its renderer — and the
 * honest answer is a row that SAYS the kind is not built yet, which is exactly
 * what `UNREGISTERED_GATE_KINDS` exists at runtime to let a surface do.
 */
export interface UnregisteredSubjectSummaryDTO {
  kind: Exclude<ApprovalGateKindDTO, 'design_result'>;
}

/**
 * What a row says about the thing being decided, per kind.
 *
 * ⚠️ TOTAL OVER `ApprovalGateKind`, not over the kinds somebody had in mind —
 * and the assertion that keeps it total lives in
 * `lib/approvalGates/subjectSummary.ts`, because THIS file is imported by client
 * modules and the registry is not (see `GateDecision`'s note above on why the
 * boundary is enforced by import SITE). Adding a fifth enum member fails the
 * build there, which is the registry's own guarantee extended to the read.
 */
export type ApprovalGateSubjectSummaryDTO =
  | DesignResultSubjectSummaryDTO
  | UnregisteredSubjectSummaryDTO;

/** The card a gate hangs off, as a queue row identifies it. */
export interface ApprovalQueueWorkItemRefDto {
  id: string;
  key: number;
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  /** The leaf's work TYPE (`design` / `code` / …); null on a container. */
  type: WorkItemTypeDto | null;
}

/**
 * ONE row of the Approvals tab: a live question, the card it is about, and
 * enough of its subject to answer it from the list.
 *
 * `state` is narrowed to `'awaiting'` rather than carried as the full union,
 * because this read returns nothing else — a decided gate is not something
 * anybody is waiting on. A row that could be `approved` would invite a renderer
 * to draw a state this read cannot produce.
 */
export interface ApprovalQueueRowDto {
  gateId: string;
  kind: ApprovalGateKindDTO;
  state: Extract<ApprovalGateStateDTO, 'awaiting'>;
  /**
   * Whether THIS reader may press this gate's verbs — the AUTHORITY answer, and
   * NEVER the routing one.
   *
   * ⚠️ IT IS NOT IMPLIED BY THE ROW'S PRESENCE, which is the trap. Routing is
   * `assigneeId ?? reporterId`, so every row in your own queue satisfies ADR
   * §2's RELATIONSHIP arm by construction — and it is tempting to conclude the
   * flag is always `true` and hardcode it. The PERMISSION FLOOR is the other
   * half the decide door applies (`work_item:edit` for `design_result`, *"on
   * top of it, not instead of it"*), and a project `viewer` can be an assignee.
   * Such a reader is routed a gate they may not decide, and a surface that
   * derived its own answer would draw verbs the door then refuses — the exact
   * disagreement `approvalGatesService.getForWorkItem` records.
   */
  canDecide: boolean;
  /** ISO-8601 — when the question was asked. The row renders how long ago. */
  waitingSince: string;
  workItem: ApprovalQueueWorkItemRefDto;
  /**
   * What is being decided — or NULL when the gate's subject no longer resolves.
   *
   * ⚠️ NULL IS A THIRD ANSWER, not a missing one, and it is distinct from the
   * not-built-yet arm above. *This build cannot render this kind* and *the row
   * this gate points at is gone* are different facts about a row, and a reader
   * needs to be told which: the first is a feature that has not shipped, the
   * second is a gate worth withdrawing. ADR §6a already admits the second — a
   * handler's `resolveSubject` is documented to return null — so a queue that
   * collapsed it into the unregistered arm would report a shipped kind as
   * unbuilt.
   */
  subject: ApprovalGateSubjectSummaryDTO | null;
}

/**
 * One OFFSET-paged window of the Approvals tab.
 *
 * ⚠️ THE SHAPE IS `HomePageDto`'s, AND THAT IS THE DECISION. `lib/dto/home.ts`
 * records why the Workbench retired its keyset (MOTIR-4852): *"a keyset has no
 * notion of 'page 7', so a reader could not see how far a tab went, jump, or
 * step back. The Workbench is not a feed."* This tab sits in the same strip,
 * under the same `IssueListPager`, so it inherits the same vocabulary — `page`
 * 1-based and CLAMPED to the last page, `total` the size of the whole set.
 */
export interface ApprovalQueuePageDto {
  items: ApprovalQueueRowDto[];
  total: number;
  page: number;
  pageSize: number;
}
