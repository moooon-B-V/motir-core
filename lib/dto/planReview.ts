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
// Refs are RESOLVED to canvas node ids server-side: an `add`'s node id is its
// PlanItem id; a `modify`/`remove`'s node id is the target work-item id (so a
// `modify` is the SAME node as the existing item, not a ghost copy). The
// intra-plan temp-ref (`planItem:<id>`) is stripped to the referenced add's
// node id; a real work-item ref stays as-is.

import type {
  PlanItemOpDto,
  PlanStatusDto,
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
  /** The canvas node id: the PlanItem id for an `add`; the target work-item id
   *  for `modify` / `remove` (same id — not a ghost copy). */
  nodeId: string;
  /** The resolved parent node id (drill placement), or null for a root. */
  parentNodeId: string | null;
  /**
   * The COMMITTED parent this proposal will be created under — resolved from the
   * same batched target read, and non-null only when `parentRef` names a real
   * work item rather than another proposal in this plan (MOTIR-3083).
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
  /** The target's identifier (`PROD-12`) — null for an un-materialized `add`. */
  identifier: string | null;
  /** The display title: the proposed title (`add`) or the live target title. */
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
  /** The target's current status key — null for a proposed `add` (none yet). */
  status: string | null;
  /** Has children in the proposed forest → the canvas can DRILL into it. */
  hasChildren: boolean;
  /** The `modify` diff (old→new) — empty for `add` / `remove`. */
  changes: PlanItemChangeDto[];
  /** This item is flagged stale (`reasons.length > 0`). */
  stale: boolean;
  staleReasons: StaleReason[];
  /** `remove` / drifted `modify`: the live target is archived or hard-deleted. */
  targetMissing: boolean;
}

/** A history event on the plan's lifecycle (the timeline). */
export interface PlanHistoryEventDto {
  /** `created` / `planned` / `approved` / `declined`. */
  kind: 'created' | 'planned' | 'approved' | 'declined';
  /** ISO timestamp, or null for a not-yet-reached event (the pending decision). */
  at: string | null;
  /** The actor's display name (the decider) — only on `approved` / `declined`. */
  byName?: string | null;
}

/** The whole plan-detail review model. */
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
   * The plan's THREE-party attribution (Story MOTIR-2982 · MOTIR-2991) — see
   * `design/ai-planning/design-notes.md` Part III.
   *
   * The detail is fed by THIS shape, not by `PlanDto`, so the fields have to be
   * carried here as well: without them the header has nothing to render however
   * complete the carrier is.
   *
   * `createdByName` is resolved from `Plan.createdById` the same way
   * `decidedByName` is; `origin` and `sourceJobId` are what distinguish the
   * remaining states — a Motir generation is `sourceJobId !== null` (the
   * generator records no author, MOTIR-2996), and *nobody asked* is
   * `origin === 'cadence'`.
   *
   * ⚠️ Unlike the LIST row, the header keeps the requester on a DECIDED plan: it
   * names the roles in words, and its decider lives in `history` below rather
   * than in the same line, so neither reason the row drops it applies here.
   */
  origin: PlanOriginDto;
  sourceJobId: string | null;
  createdByName: string | null;
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
  authorModel: string | null;
  /** The lifecycle timeline (created → planned → decision). */
  history: PlanHistoryEventDto[];
  /** The proposed items, enriched for the canvas. */
  items: PlanReviewItemDto[];
  /** Roll-up: any item is stale (the plan-level "N may be out of date"). */
  stale: boolean;
  /** How many items are stale (the summary count). */
  staleCount: number;
}
