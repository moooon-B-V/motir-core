import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { WorkItemKindDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';

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

/**
 * The payload every status door carries when the approval-gate guard refuses a
 * move (`APPROVAL_GATE_PENDING` — Story MOTIR-4887 · Subtask MOTIR-5526; ADR
 * `approval-gates.md` §6d AMENDMENT, rule 4). ONE shape on the board move, the
 * status server action, `/api/v1` and MCP, so a surface renders the refusal
 * without re-deriving any of it.
 *
 * - `itemKey` + `kind` address the approval overlay (`overlayAddress.ts`).
 * - `canDecide` is the same answer the approval frame draws its verbs from — the
 *   kind's permission floor AND §2's authority — so a surface never offers a
 *   Review & approve button the door would then refuse.
 * - `routedToLabel` names whose decision it is, for the reader who may only look.
 */
export interface ApprovalGatePendingPayloadDTO {
  itemKey: string;
  kind: ApprovalGateKindDTO;
  /** `decision` — the gate awaits a person, and the surface offers Review &
   *  approve to one who may decide. `merge` — it is already approved and the
   *  item's pull request is still open, so the surface offers no approve door:
   *  the merge makes the move (ADR §6d AMENDMENT, rule 2b). */
  waitingOn: 'decision' | 'merge';
  /** False while a pull request is open and no gate has been raised yet (its
   *  checks are not green) — the status control then says the approval is
   *  asked for once they pass, rather than naming someone it is waiting on. */
  gateRaised: boolean;
  canDecide: boolean;
  routedToLabel: string | null;
}

/**
 * One status move an approval holds on a work item, as the STATUS CONTROL draws it
 * before anyone tries the move (Story MOTIR-4887 · Subtask MOTIR-5528; design
 * `design/work-items/design-notes.md` § _The status control says so_). The same
 * rule the guard refuses with — `heldMoves` — read outside any lock.
 */
export interface HeldTransitionDTO {
  statusKey: string;
  /** The held status's own label, for the sentence. */
  statusLabel: string;
  waitingOn: 'decision' | 'merge';
  /** The kind whose decision this is — addresses the overlay. */
  kind: ApprovalGateKindDTO;
  /** Null while a pull request is open and no gate has been raised yet. */
  gateId: string | null;
  /** A Review & approve door is drawn only when true: a `decision` move with a gate
   *  actually awaiting, and this reader holding the floor AND the authority. */
  canDecide: boolean;
  routedToLabel: string | null;
}

/** Where a gate's decision stands (ADR §6b). Mirrors the `ApprovalGateState`
 *  Prisma enum. */
export type ApprovalGateStateDTO = 'awaiting' | 'approved' | 'changes_requested' | 'superseded';

/**
 * WHY a `superseded` gate was withdrawn — mirrors the `ApprovalGateSupersedeCause`
 * Prisma enum (`design-result.md` AMENDMENT 6 Q5). One value per writing path, and
 * **no value meaning _unsaid_**: `unknown` says the row PREDATES the column, which
 * is a different fact from any live cause.
 */
export type ApprovalGateSupersedeCauseDTO =
  | 'republished'
  | 'withdrawn'
  | 'head_moved'
  | 'member_closed'
  | 'member_drafted'
  | 'set_changed'
  | 'pulled_back'
  | 'unknown';

/** Under which §2 authority rung the decision was made (ADR §6a). Mirrors the
 *  `ApprovalGateAuthority` Prisma enum. Frozen at decision time, so a reader can
 *  answer *"was this person entitled?"* without re-deriving a role that has
 *  since changed.
 *
 *  `github_review` is NOT a §2 rung (ADR §8 FOURTH AMENDMENT, MOTIR-5590,
 *  decision 4): it is authority conferred by the HOST's review permission, and it
 *  is written only by the synced decision. `resolveGateAuthority` never returns
 *  it, so no Motir surface can produce one. */
export type ApprovalGateAuthorityDTO = 'assignee' | 'reporter' | 'admin' | 'github_review';

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
  /**
   * WHY the question was withdrawn — null on every state but `superseded`
   * (Story MOTIR-5652 · Subtask MOTIR-5659 wrote it, MOTIR-5667 renders it).
   *
   * ⚠️ IT IS NOT AN ACTOR AND MUST NEVER BE RENDERED AS ONE. §6b's supersede
   * carries no decider, no authority and no note on purpose; a cause says what
   * happened to the SUBJECT. A surface that turned it into *somebody withdrew
   * this* would put a decision nobody made into the one record an audit trusts.
   *
   * ⚠️ `unknown` MEANS THE REASON WAS NOT RECORDED — a row that predates the
   * column. A surface renders it as exactly that and NEVER as one of the real
   * causes, because inferring one from a row's shape manufactures evidence, and
   * these sentences are shown to a person as fact.
   */
  supersededCause: ApprovalGateSupersedeCauseDTO | null;

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

// ⚠️ `PullRequestMergeSubjectSummaryDTO` WAS HERE (MOTIR-4793) and retired with its
// kind (Bug MOTIR-5603 · MOTIR-5616). It named ONE pull request, because a merge gate
// asked about one; the gate that survives asks about the whole delivery set and names
// every member below. A superseded row of the old kind now reads through
// `UnregisteredSubjectSummaryDTO`, like every other kind this build does not render.

/**
 * WHICH PULL REQUESTS an approve-and-merge gate is asking about, at row scale (MOTIR-5481)
 * — every member of the card's delivery set, in canonical order (`owner/name#number`),
 * with the head its latest checks ran on and whether it is still open.
 */
export interface PullRequestApprovalSubjectSummaryDTO {
  kind: 'pull_request_approval';
  members: {
    /** `owner/name`. */
    repo: string;
    number: number;
    /** The head commit the latest recorded checks ran on, or null when none reported. */
    headSha: string | null;
    state: 'open' | 'closed' | 'merged';
  }[];
}

/**
 * A gate whose KIND THIS BUILD REGISTERS NO RENDERER FOR — a real row on the
 * day this ships, not a defensive branch.
 *
 * `lib/approvalGates/registry.ts` registers two kinds and names the other two as
 * declared holes: `decision_approval`, which MOTIR-4907 will build, and
 * `pull_request_merge`, which MOTIR-5616 RETIRED — built once, withdrawn, and never
 * to be registered again. A gate carrying either can exist — a fixture, a
 * half-landed sibling, or one of the superseded merge rows the backfill left — and
 * the honest answer is a row that SAYS the kind is not built here, which is exactly
 * what `UNREGISTERED_GATE_KINDS` exists at runtime to let a surface do.
 */
export interface UnregisteredSubjectSummaryDTO {
  kind: Exclude<ApprovalGateKindDTO, 'design_result' | 'pull_request_approval'>;
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
  | PullRequestApprovalSubjectSummaryDTO
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
  /**
   * WHOSE DECISION THIS IS — the name the row's *waiting on* line draws when the
   * reader may see the gate but not press it (Panel 5, `design/workbench/design-notes.md`
   * § 20; MOTIR-5191). Null when the routing resolves to nobody or to a user row
   * that has gone, and the frame draws its generic fallback instead.
   *
   * ⚠️ IT IS THE LIVE ROUTING ANSWER, and on this read that is very nearly
   * always the READER — the predicate selected these rows BY it. It is carried
   * per row anyway rather than being taken from the session, because a row that
   * names its own recipient keeps saying something true if §2's routing is ever
   * widened past one person, and a surface reading the session would not.
   */
  routedToName: string | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVALS ROOM's READ (Story MOTIR-5299 · MOTIR-5301) — every approval
// record a reader may see in the active project, pending first then decided.
// The shape is `design/approvals/design-notes.md` § GIVES / TAKES's requirements
// on this read, not a choice made here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE decided record: the question, the card, and the AUDIT set that makes it a
 * record rather than a list entry — who decided, when, and on which bytes.
 *
 * `state` is narrowed to the two DECISIONS. `superseded` is neither pending nor
 * decided (ADR §6b: nobody decided it), and the room lists it nowhere, so a row
 * that could carry it would invite a renderer to draw a state this read cannot
 * produce.
 */
export interface ApprovalRecordDecidedRowDto {
  gateId: string;
  kind: ApprovalGateKindDTO;
  state: Extract<ApprovalGateStateDTO, 'approved' | 'changes_requested'>;
  /** ISO-8601 — when the decision was recorded. The section's sort key. */
  decidedAt: string;
  /**
   * WHO decided, as recorded AT the decision (`Name <email>`) — the column that
   * survives the user's deletion where `decidedById`'s `SetNull` FK does not.
   * Null only on a row decided before the audit columns existed.
   */
  decidedByLabel: string | null;
  /**
   * THROUGH WHICH SURFACE the decision arrived (Story MOTIR-4910 · MOTIR-5599). The room's
   * person cell reads it to add the *on GitHub* suffix, because *who* and *where* are one
   * question in a 144px cell. Null on a row decided before the audit columns existed.
   */
  decisionSource: ApprovalGateDecisionSourceDTO | null;
  /**
   * The immutable version the decision was made against — ADR §6a's field that
   * *carries the whole claim*. Null where the kind records none.
   */
  subjectVersion: string | null;
  /** ISO-8601 — when the question was asked. */
  waitingSince: string;
  workItem: ApprovalQueueWorkItemRefDto;
  /** What was decided, or NULL when the gate's subject no longer resolves. */
  subject: ApprovalGateSubjectSummaryDTO | null;
}

/** One SECTION of the room: its rows on this page, and its total over every page. */
export interface ApprovalRecordsSectionDto<Row> {
  items: Row[];
  /**
   * The section's total across the whole list, not this page's count — the section
   * heading carries it, so a reader on page 3 still knows how many are waiting.
   */
  total: number;
}

/**
 * The room's one page.
 *
 * ⚠️ THE SECTION BOUNDARY IS HERE, NOT INFERRED DOWNSTREAM. `awaiting` precedes
 * `decided`, and a surface renders the two sections rather than grouping rows by a
 * state field.
 *
 * ⚠️ ONE WINDOW OVER THE CONCATENATION. `page` / `pageSize` window the ordered list
 * *pending-then-decided*, and `total` is `sections.awaiting.total +
 * sections.decided.total` — the pager's denominator, which therefore cannot
 * disagree with the rows. A page can hold rows of both sections, or of only one.
 */
export interface ApprovalRecordsPageDto {
  /**
   * Whether this reader holds `approval:view_any` — a FACT ABOUT THE ANSWER, which
   * the surface reads for copy and for the person column. It is never an input: no
   * caller can ask the read for the wider view.
   */
  fullView: boolean;
  sections: {
    awaiting: ApprovalRecordsSectionDto<ApprovalQueueRowDto>;
    decided: ApprovalRecordsSectionDto<ApprovalRecordDecidedRowDto>;
  };
  total: number;
  page: number;
  pageSize: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVAL OVERLAY's READ (Story MOTIR-5214 · Subtask MOTIR-5223) — what
// `GET /api/work-items/approval-gate` answers for ONE work item and ONE kind.
//
// The overlay is addressed by a URL that can be pasted into a cold tab, so it
// holds no queue row to hand a server action: it asks for the gate, whether
// this reader may decide it, and the subject the port renders, in one read.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the PORT has to render, per kind — FOUR answers, and none of them is an
 * absence of an answer.
 *
 * ⚠️ `no_gate`, `kind_not_built` and `gone` ARE DIFFERENT FACTS, and a surface
 * that collapsed any two would tell the reader something false
 * (`design/workbench/design-notes.md` § 20 refuses the same collapse on a row):
 * the card has no question of this kind · this build cannot render this kind
 * yet · the bytes this question was about no longer resolve.
 */
export type ApprovalGateOverlaySubjectDTO =
  | { state: 'no_gate' }
  | { state: 'kind_not_built' }
  | { state: 'gone' }
  | {
      state: 'resolved';
      kind: 'design_result';
      /** The version the gate asks about — read by the gate's `subjectId`. */
      evidence: DesignEvidenceDTO;
      /** `DesignGateSubjectDTO.filesKept`, off the row rather than the state. */
      filesKept: boolean;
    }
  | {
      state: 'resolved';
      kind: 'pull_request_approval';
      /**
       * THE DEVELOPMENT BLOCK'S DATA (Story MOTIR-5437 · Subtask MOTIR-5439) — the
       * approve-and-merge gate's port is the item page's Development block
       * (`design/github/design-notes.md` § 20), so the overlay reads exactly what
       * `LateUpperSections` hands `DevelopmentSectionBody`, from the same services.
       * Two surfaces reading one block from two different reads could disagree about
       * which pull requests exist; these cannot.
       */
      pullRequests: LinkedPullRequestDto[];
      /** `workItemsService.getDeliveryView(…).repos` — the item's repository set,
       *  amended by its delivery set, verbatim. */
      repoDelivery: RepoDelivery[];
      /** `workItemsService.getDeliveryView(…).deliveries` — the delivery set itself. */
      deliveries: WorkItemDeliveryDto[];
      /** The block's second part. `record_missing` is an ANSWER here, not an error. */
      howToTest: HowToTestDto;
      /**
       * The card's CURRENT design result, or null. On a card with an open linked pull
       * request the result renders inside this block rather than as its own section
       * (`design-result.md` AMENDMENT 4 Q8), so the port needs it.
       */
      designEvidence: DesignEvidenceDTO | null;
      /** Whether the card is a `design` leaf — `DesignResultPanel`'s own input. */
      isDesignCard: boolean;
      /**
       * What a reload still knows about each member once the gate is APPROVED — the
       * item page's `mergeGate.members`, read under the same condition. Empty for any
       * other state: before the press nothing merged, and a withdrawn question merged
       * nothing.
       */
      members: PullRequestApprovalMemberDTO[];
    };

/** The overlay's one read. */
export interface ApprovalGateOverlayReadDTO {
  /** The card the address named — what the overlay's header identifies. */
  workItem: { id: string; identifier: string; title: string };
  /** The gate of the asked kind, whatever its state; null when the card has none. */
  gate: ApprovalGateDTO | null;
  /** The AUTHORITY answer (`approvalGatesService.getForWorkItem`), never the routing one. */
  canDecide: boolean;
  /** Whose decision it is waiting on, as a name — the frame's state `B` line. */
  routedToLabel: string | null;
  /**
   * WHAT THIS READER IS BEING SHOWN — hand it back with the press (Story MOTIR-5232 ·
   * Subtask MOTIR-5234; `WorkItemGateRead.stamp`). Opaque: compare nothing, parse
   * nothing. Null when the gate is not `awaiting`.
   */
  stamp: string | null;
  subject: ApprovalGateOverlaySubjectDTO;
}

/**
 * One member of an approve-and-merge set as the Development frame reads it BACK after a reload
 * (Story MOTIR-4909 · Subtask MOTIR-5484) — the two facts that outlive the press's response.
 *
 * ⚠️ NO REFUSAL REASON. The press does not persist one, so a reloaded page can say a pull
 * request has not merged yet and offer the retry, and must never say why.
 */
export interface PullRequestApprovalMemberDTO {
  /** `owner/name#number@headSha`, as the approval named the member. */
  subjectVersion: string;
  /** The pull request the member names, while this card still delivers it (MOTIR-5613) —
   *  what *Retry merge* presses, together with the card's own gate. */
  pullRequestId: string | null;
  /** The press handed it to its repository's merge queue, and it has not merged yet. */
  queued: boolean;
  /** Motir has neither merged nor queued it yet, so it can be tried again under the
   *  approval that already stands. No second gate is involved. False while the member
   *  carries a merge-queue exit that has not been put back — that member offers
   *  {@link requeueable} instead. */
  retryable: boolean;
  /** The pull request's latest merge-queue EXIT (MOTIR-5632), or null when the queue
   *  never removed it. The failing check's name and link are MOTIR-5633's. */
  exit: PullRequestQueueExitDTO | null;
  /** *Queue again* is offered (MOTIR-5634; `approval-gates.md` §4 THIRD AMENDMENT,
   *  decision 5): the approval stands, the latest exit has not been put back, and the
   *  pull request is still at the head the approval named. */
  requeueable: boolean;
}

/** One merge-queue removal as a surface reads it (MOTIR-5632 · MOTIR-5634). */
export interface PullRequestQueueExitDTO {
  /** The host's own reason string, verbatim — the frame words it. */
  rawReason: string;
  disposition: 'failure' | 'neutral';
  /** The head the pull request left the queue at. */
  headSha: string;
  exitedAt: string;
  /** When *Queue again* put it back; null while the exit stands. */
  requeuedAt: string | null;
  /** The merge-queue check that failed, and its page (MOTIR-5633). Both null when no
   *  check is known — a conflict, a neutral removal, or a check nobody could tie back;
   *  the frame then states the reason alone. */
  failingCheckName: string | null;
  failingCheckUrl: string | null;
}

/** A pull request the merge queue removed and nobody has put back, on a card with NO
 *  approval gate — an `auto` project (MOTIR-5635; design § 22, E5). */
export interface PullRequestStandingExitDTO {
  pullRequestId: string;
  /** `owner/name`, as the row names its repository. */
  repo: string;
  number: number;
  exit: PullRequestQueueExitDTO;
  /** *Queue again* is honest: the pull request is open and still at the head it left at. */
  requeueable: boolean;
}

/** One member of an approve-and-merge press, and what happened to it (MOTIR-5483). */
export type ApproveAndMergeMemberOutcomeDTO =
  | {
      /** The member as the approval named it: `owner/name#number@headSha`. */
      subjectVersion: string;
      pullRequestId: string;
      outcome: 'merged' | 'enqueued';
    }
  | {
      subjectVersion: string;
      /** Null when the member was refused before a pull request could be resolved. */
      pullRequestId: string | null;
      outcome: 'refused';
      /** The refusal in the frame's vocabulary — MOTIR-4882's union for a host refusal. */
      refusal: GateRefusal;
    }
  | {
      subjectVersion: string;
      pullRequestId: null;
      /** ⚠️ SINCE MOTIR-5613 THIS NAMES NO GATE: this card no longer delivers that pull
       *  request at the head it was approved at, so there is nothing to merge. The literal
       *  is kept until MOTIR-5615 renames it with the frame's copy. */
      outcome: 'no_merge_gate';
    };
