// The RENDER-READY plan-review model (Story 7.21 · Subtask 7.4.5 / MOTIR-847).
// The plan-detail UI mounts the reusable `ProjectRoadmapCanvas` (MOTIR-1194) fed
// the plan's PlanItems as data and draws each by its `op`. To draw a `modify` /
// `remove` it needs the EXISTING target's live fields (the OLD side of the diff,
// the node identity), and the history surface needs the decider's NAME — neither
// is on the raw `PlanWithItemsDto`. `planReviewService.getPlanReview` ASSEMBLES
// the plan + its staleness (MOTIR-1340) + the live targets (one batched read) +
// the decider into THIS shape, so the client renders without touching the
// service layer or issuing N work-item reads.
//
// Refs are RESOLVED to canvas node ids server-side, by ONE rule for all three
// ops (MOTIR-3160): a node id is the WORK ITEM the proposal is about, falling
// back to the PlanItem id when there is not one yet. So a `modify`/`remove` is
// the SAME node as the existing item rather than a ghost copy; an
// un-materialized `add` keys by its own id, because it is not about anything
// yet; and an `add` that HAS been materialized keys by the work item it became,
// which is what lets a decided proposal land ON that node instead of beside it.
// The intra-plan temp-ref (`planItem:<id>`) is resolved to the referenced item's
// NODE id — not to the referenced id itself, which would point at a node that is
// no longer on the canvas once that item materialized; a real work-item ref
// stays as-is.

import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  PlanItemOpDto,
  PlanStatusDto,
  PlanDecisionReasonDto,
  StaleReason,
  PlanAuthorSourceDto,
  PlanOriginDto,
} from '@/lib/dto/plans';

/**
 * Every field name `planReviewService.buildChanges` can emit on a `modify`'s
 * diff overlay — the WIRE vocabulary the review surfaces localize.
 *
 * It is a closed list on purpose (MOTIR-3151). Each surface names its label by
 * interpolating the field into a message key (`field_<name>`), which no compiler
 * can follow — so when MOTIR-1532 taught `buildChanges` to emit `storyPoints` /
 * `estimateMinutes` and stopped at the producer, the plan-review canvas rendered
 * `planReview.field_storyPoints` at a reader for weeks and nothing failed.
 * Adding a member here is what makes
 * `tests/components/plan-change-field-labels.test.tsx` demand its copy — in both
 * catalogs, and in each of the three maps that stand between a field and a word.
 */
export const PLAN_ITEM_CHANGE_FIELDS = [
  'title',
  'priority',
  'type',
  'storyPoints',
  'estimateMinutes',
  'description',
  'explanation',
  'links',
  /** Where the target SITS — a `modify`'s `patch.parentRef` (MOTIR-3859). The
   *  approver has to SEE a re-parent: it is the most structural thing a plan can
   *  say about a card, and the whole reason the move was routed through the
   *  proposal door rather than applied directly. */
  'parent',
  /** Where the target SHIPS — a `modify`'s `patch.targetRepo` (MOTIR-1884) and
   *  `patch.targetRepoRole` (MOTIR-1912), the other half of D3's `SITS or SHIPS`
   *  pair `parent` above completes (bug MOTIR-3868).
   *
   *  Neither had a row at all, so a `modify` carrying ONLY a re-pin rendered as a
   *  proposal with an EMPTY change list — a row that says a card is being changed
   *  and declines to say how — while `applyModify` read and applied both. A re-pin
   *  decides which repository the card ships in, which checkout the CLI is
   *  dispatched into, and (through the container rollup) the derived repository set
   *  of every ancestor; it is the wrong field to be silent about. */
  'targetRepo',
  'targetRepoRole',
] as const;

export type PlanItemChangeField = (typeof PLAN_ITEM_CHANGE_FIELDS)[number];

/** One field's OLD → NEW change in a `modify` proposal (the diff overlay). */
export interface PlanItemChangeDto {
  /**
   * The changed field. The producer emits one of {@link PLAN_ITEM_CHANGE_FIELDS}
   * and is typed to (`buildChanges`), but this stays a plain `string`: a client
   * bundle can be older than the server that answered it, and a surface that
   * cannot even REPRESENT a field it does not know cannot fall back for one.
   */
  field: string;
  /** The live OLD value (read from the target), or null when there was none. */
  from: string | null;
  /** The proposed NEW value, or null when the change removes it. */
  to: string | null;
}

/**
 * One crumb on the COMMITTED ancestor path a proposal's parent sits on — the
 * breadcrumb the plan canvas opens with (bug MOTIR-3152).
 *
 * `PlanReviewItemDto` carried the IMMEDIATE parent only, so the canvas could
 * synthesise exactly one crumb and every ancestor above it was missing. The
 * design (`design/ai-planning/design-notes.md` Part V §2 panel E) asks for *"the
 * committed ancestor path down to the focused level, exactly as the roadmap draws
 * it"* — which is a CHAIN, and a chain has to be carried rather than invented.
 */
export interface PlanParentCrumbDto {
  id: string;
  identifier: string;
  title: string;
}

/** A proposed operation, enriched for the canvas + review rail. */
export interface PlanReviewItemDto {
  /** The PlanItem id — the stable review key. */
  planItemId: string;
  op: PlanItemOpDto;
  /** The canvas node id: the target work-item id whenever the proposal HAS one
   *  (a `modify` / `remove`, or an `add` that has been materialized — same id,
   *  not a ghost copy); the PlanItem id for an `add` that has not. */
  nodeId: string;
  /**
   * The resolved parent node id (drill placement), or null for a root.
   *
   * ONE rule for all three ops (bug MOTIR-3191): an `add` names its parent in
   * `parentRef`; a `modify` / `remove` names none — it cannot, since its parent
   * is the live card's and a proposal may not move anything — so its placement is
   * read off the TARGET's own `parentId`. Before that, a proposal ABOUT an
   * existing card arrived with a null parent and every consumer drew it as a
   * ROOT, which is where the plan rules put epics and nothing else.
   */
  parentNodeId: string | null;
  /**
   * The COMMITTED parent this proposal sits under — resolved from the same
   * batched read, for a `parentRef` naming a real work item AND for the parent a
   * `modify` / `remove` inherits from its target (MOTIR-3083, MOTIR-3191).
   *
   * It is what the canvas opens a LEVEL at and what the breadcrumb names. Before
   * this the review model carried no field that could name the parent at all, so
   * a proposal under a committed item drew at the top level indistinguishable
   * from a genuine root — `isRoot` is true both for "no parent" and for "a parent
   * outside the rendered set", which is correct for a partial subtree and wrong
   * for this. The distinction lives here, in the plan's own model, rather than in
   * that shared predicate.
   *
   * All three are null for a root, for an intra-plan (`planItem:`) parent, and
   * for a parent that has been archived or hard-deleted — the last case degrades
   * to the root rendering rather than failing the read.
   */
  parentIdentifier: string | null;
  parentTitle: string | null;
  parentKind: string | null;
  /**
   * The COMMITTED ancestor path down to `parentNodeId` — ROOT FIRST, the parent
   * itself LAST (bug MOTIR-3152). This is what the canvas breadcrumb walks: the
   * roadmap names a level by its whole chain, and the three fields above can only
   * name its last link.
   *
   * `[]` in exactly the cases the three fields above are null: a root proposal, an
   * intra-plan (`planItem:`) parent, and an archived / hard-deleted parent — the
   * last degrading to the root rendering rather than failing the read.
   */
  parentTrail: PlanParentCrumbDto[];
  /** Resolved blocked-by node ids (within the proposed forest). */
  blockedByNodeIds: string[];
  /** The target's identifier (`PROD-12`) — null for an un-materialized `add`,
   *  which has no key, and the target's real key for every proposal that does. */
  identifier: string | null;
  /**
   * The display title — **the title this proposal is ASKING for**, on every op
   * (MOTIR-4018, design Part XIII §1).
   *
   * An `add` reports its proposed title; a `modify` reports `patch.title` when
   * the patch carries one and the target's live title when it does not; a
   * `remove` reports the target's, which is the only title it has.
   *
   * ⚠️ IT USED TO REPORT THE TARGET'S TITLE FOR EVERY NON-`add` OP, and the
   * sentence describing that is worth keeping because the defect it produced is
   * the kind nothing catches: a plan renaming a card drew the node, its
   * breadcrumb crumb, its search text and the list row's headline under the name
   * the card is about to STOP being called — while the same response carried the
   * proposed one three lines away, as a `changes` row. The surface named the card
   * by what it is called and, much more quietly, by what it will be called.
   *
   * The `changes` array is UNCHANGED and still carries both sides
   * (`{ field: 'title', from: <live>, to: <proposed> }`): the node is a SIGNAL and
   * the list is where a change is SPELLED (Part VIII §3), so this field says what
   * the card will BE and the diff says what it is leaving.
   */
  title: string;
  /** The work-item kind (`epic`/`story`/`task`/`bug`/`subtask`); defaults `task`. */
  kind: string;
  /** The `add`'s proposed PRIORITY — `null` for a `modify`/`remove` (only an
   *  `add` is editable, 7.21.6 · MOTIR-1370) or an `add` with none set. */
  priority: string | null;
  /** The `add`'s proposed work-item TYPE (`code`/`design`/…) — `null` as above. */
  type: string | null;
  /** The `add`'s proposed DESCRIPTION (Markdown) — `null` as above. */
  descriptionMd: string | null;
  /**
   * EVERY remaining `PlanItemProposedFields` value that `materialize` writes onto
   * the created work item (MOTIR-3084). All `null` for a `modify` / `remove`,
   * which describe an existing item rather than propose a new one.
   *
   * They are here because the review surface is a stop on the seam and was
   * missing from it: `explanationMd` is carried on the proposal, diffed, and
   * materialized, and NOTHING in the review surface read it — a reviewer
   * approved a second content body they were never shown. `targetRepo` is the
   * same failure with a sharper consequence: it routes dispatch, and it was
   * invisible at the one moment a person could still correct it.
   *
   * ⚠️ This list is not a place to be conservative. `tests/dto/planReviewFieldParity.test.ts`
   * holds it against `PlanItemProposedFields` and goes RED when the two diverge —
   * which is the durable half of this fix, because the four fields above are only
   * today's instance. `planningProvenance` is the proof: it was added to the
   * proposal and not to this model while the card to fix that was in the backlog.
   */
  explanationMd: string | null;
  explanationSource: string | null;
  storyPoints: number | null;
  estimateMinutes: number | null;
  targetRepo: string | null;
  targetRepoRole: string | null;
  executor: string | null;
  planningProvenance: { source?: string; harness?: string | null; model?: string | null } | null;
  /** The target's current status key — null for an un-materialized `add` (it is
   *  not a work item yet); the live status for every proposal that has one. */
  status: string | null;
  /** The target status's own display LABEL, from the project's workflow (bug
   *  MOTIR-3170). Null for an `add`, and for a target whose status the workflow
   *  no longer holds. The canvas chip cannot name a CUSTOM status out of the
   *  `labels.defaultStatus` catalog, so the identity travels beside the key. */
  statusLabel: string | null;
  /** The target status's lifecycle CATEGORY — the chip's fallback tone when the
   *  canvas has no per-key treatment (see `statusLabel`). */
  statusCategory: StatusCategoryDto | null;
  /** Has children in the proposed forest → the canvas can DRILL into it. */
  hasChildren: boolean;
  /** The `modify` diff (old→new) — empty for `add` / `remove`. */
  changes: PlanItemChangeDto[];
  /** This item is flagged stale (`reasons.length > 0`). */
  /**
   * This proposal MOVED in the plan's latest revision (Subtask MOTIR-3601;
   * `design-notes.md` Part XII §E).
   *
   * ⚠️ A RECENCY fact, and NOT the same question `op` answers. `op` says WHICH
   * KIND of change this proposal is; this says THAT this one moved since the
   * reviewer last looked. Orthogonal, exactly as Part IX §L2 holds for the
   * canvas's emphasis — a build must not read either as an alternative to the
   * other.
   *
   * Derived from the trail's `planItemId`, so it needs no column: the rows
   * written between the latest `revision_started` and its terminator name every
   * proposal that revision touched. False on every plan that has never been
   * revised, which is every plan written before this story.
   */
  revised: boolean;

  stale: boolean;
  staleReasons: StaleReason[];
  /** `remove` / drifted `modify`: the live target is archived or hard-deleted. */
  targetMissing: boolean;
}

/**
 * The LIFECYCLE half of the timeline's vocabulary — a state the plan REACHED,
 * derived from the `Plan` row's own columns and never stored.
 *
 * `created` / `planned` / `approved`, and the THREE endings a `declined` plan
 * can have — `declined` (a person reviewed it and said no), `discarded` (a
 * person ended it mid-generation) and `abandoned` (the sweep terminated a dead
 * producer).
 *
 * ⚠️ The kind is the EVENT, not the status (MOTIR-3189). All three endings leave
 * `Plan.status = 'declined'`; what separates them is `Plan.decisionReason`, and
 * the timeline is the surface whose whole job is to say what happened. Before
 * this the service pushed one `declined` event for all three and the rail
 * rendered them identically — you could see that a plan ended and not why.
 */
export type PlanLifecycleEventKind =
  | 'created'
  | 'planned'
  | 'approved'
  | 'declined'
  | 'discarded'
  | 'abandoned';

/**
 * A history event on the plan's timeline — a LIFECYCLE transition (above) or,
 * since MOTIR-3536, a CONTENT act somebody performed on the plan.
 *
 * ⚠️ ONE SEQUENCE, ONE SHAPE, and the KIND's own wording is what tells a reader
 * which of the two it is reading (`design/ai-planning/design-notes.md` Part X
 * §2). A lifecycle kind names a state the plan reached; a content kind names an
 * act, and carries a `count` of the proposals it covered. There is deliberately
 * no second treatment, no second dot and no grouping into two blocks: nobody
 * filters this list and nothing acts differently on the two halves, so a second
 * visual language would ask the reader to learn a distinction that pays nothing.
 *
 * ⚠️ THE FOUR DERIVED EVENTS ARE UNCHANGED BY THE WIDENING. Every field this
 * interface gained is optional, and a lifecycle event sets none of them — so a
 * plan created before the trail existed produces exactly the event list it
 * produced before, which is the state EVERY pre-existing plan is in.
 */
export interface PlanHistoryEventDto {
  /**
   * A stable per-EVENT identity — the revision's own id for a stored event,
   * `lifecycle:<kind>` for a derived one.
   *
   * It exists because the rail keyed its rows by `kind`, which was unique only
   * for as long as each kind occurred at most once. Content events repeat, and
   * React then reconciles a list of duplicate keys (measured while drawing the
   * asset: eight events with a repeated kind render, and log *"Encountered two
   * children with the same key"*).
   */
  id: string;
  /** A lifecycle transition, or a stored content act (`appended`, `edited`, …). */
  kind: PlanLifecycleEventKind | string;
  /** ISO timestamp, or null for a not-yet-reached event (the pending decision). */
  at: string | null;
  /**
   * A collapsed RUN's LAST instant, `at` being its first — rendered as a span in
   * the same slot a single event's timestamp uses. Absent on every event that is
   * not a collapsed run (Part X §5).
   */
  until?: string | null;
  /** How many PROPOSALS a content event covered. Absent on a lifecycle event. */
  count?: number;
  /** The actor's display name — the decider on a decision event, the acting
   *  person on a content one. Null when nobody acted as a person. */
  byName?: string | null;
  /**
   * WHICH AGENT acted, when one did (Part X §4). `actorSource` picks the KIND of
   * label — `mcp` renders the harness, `native` renders Motir — and `actorModel`
   * is deliberately NOT rendered on a row: measured at the rail's 298px text
   * column, the model costs every row a second line, and the header carries it
   * once already. It rides the DTO so the row can carry it as a `title`.
   */
  actorSource?: PlanAuthorSourceDto | null;
  actorHarness?: string | null;
  actorModel?: string | null;
}

/** The whole plan-detail review model. */
/**
 * A revision in flight, as the review surface reads it (Subtask MOTIR-3601).
 *
 * Present ⟺ the lease is HELD. There is no `inFlight: false` shape, deliberately:
 * a null is one check at the call site and cannot be misread as *a revision that
 * finished*, which a `{ inFlight: false }` object routinely is.
 */
export interface PlanRevisionStateDto {
  /** The harness running it, when the trail recorded one. */
  heldBy: string | null;
  /** When the lease ages out if the job never reports back — the ONLY thing that
   *  recovers a plan whose revision job died. */
  expiresAt: string;
  /** WHEN it started, so the surface can say how long it has been running. */
  startedAt: string;
}

export interface PlanReviewDto {
  id: string;
  projectId: string;
  status: PlanStatusDto;
  title: string | null;
  summary: string | null;
  itemCount: number;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
  /** The decider's display name, resolved from `decidedById`. */
  decidedByName: string | null;
  /**
   * WHY a `declined` plan ended (MOTIR-3189) — what the outcome block reads to
   * avoid telling a reader their half-generated plan was reviewed and rejected.
   *
   * Null on every plan that is not `declined`, and on a `declined` row written
   * before the column existed. A null is *not recorded*, so the surface falls
   * back to the plain declined wording rather than inventing a reason.
   */
  decisionReason: PlanDecisionReasonDto | null;
  /**
   * The plan's THREE-party attribution (Story MOTIR-2982 · MOTIR-2991) — see
   * `design/ai-planning/design-notes.md` Part III.
   *
   * The detail is fed by THIS shape, not by `PlanDto`, so the fields have to be
   * carried here as well: without them the header has nothing to render however
   * complete the carrier is.
   *
   * `createdByName` is resolved from `Plan.createdById` the same way
   * `decidedByName` is; `authorSource` alone answers WHO WROTE it — `mcp` is an
   * agent, `native` is Motir (MOTIR-2996) — and *nobody asked* is
   * `origin === 'cadence'`.
   *
   * ⚠️ `sourceJobId` used to be carried here purely so the header could tell a
   * Motir generation from an unattributed plan, back when the generator recorded
   * no author. It is GONE (MOTIR-2996): the generator records `native · Motir`,
   * so the fact has one source rather than two, and the DTO no longer ships a
   * field whose only reader was an inference.
   *
   * ⚠️ Unlike the LIST row, the header keeps the requester on a DECIDED plan: it
   * names the roles in words, and its decider lives in `history` below rather
   * than in the same line, so neither reason the row drops it applies here.
   */
  origin: PlanOriginDto;
  createdByName: string | null;
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
  authorModel: string | null;
  /** The lifecycle timeline (created → planned → decision). */
  history: PlanHistoryEventDto[];
  /** The proposed items, enriched for the canvas. */
  /**
   * The REVISION the reviewer is watching, or null when none is running (Story
   * MOTIR-3595 · Subtask MOTIR-3601; `design/ai-planning/design-notes.md`
   * Part XII §C).
   *
   * ⚠️ DERIVED FROM THE PLAN'S OWN TRAIL — no column, no table. A
   * `revision_started` with no `revision_ended` after it, inside the lease
   * window, IS the lease (`agent-authored-plans.md` AMENDMENT 10 D2), and it is
   * the same pair the timeline renders. So the surface that must disable Approve
   * and the surface that tells the reviewer WHY read one fact from one place.
   *
   * `heldBy` is the HARNESS, never the model — the discriminator Part X §4 fixed
   * for the timeline clause, reused here for the same reason: a harness name is
   * what a reader recognises and a model is one level of detail below what a
   * held button needs to say.
   */
  revision: PlanRevisionStateDto | null;

  items: PlanReviewItemDto[];
  /** Roll-up: any item is stale (the plan-level "N may be out of date"). */
  stale: boolean;
  /** How many items are stale (the summary count). */
  staleCount: number;
}
