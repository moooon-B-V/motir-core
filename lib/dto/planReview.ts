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

/** One field's OLD → NEW change in a `modify` proposal (the diff overlay). */
export interface PlanItemChangeDto {
  /** The changed field — `title` / `priority` / `type` / `description` / `links`. */
  field: string;
  /** The live OLD value (read from the target), or null when there was none. */
  from: string | null;
  /** The proposed NEW value, or null when the change removes it. */
  to: string | null;
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
  /** The `add`'s proposed DESCRIPTION (Markdown) — `null` as above. The inline
   *  edit form seeds from these three; the compact canvas node never renders them. */
  descriptionMd: string | null;
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
