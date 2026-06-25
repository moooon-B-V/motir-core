// DTO types for the AI-planning Plan substrate (Story 7.21 · MOTIR-1336). The
// shape that crosses the API boundary — no Prisma row leaks (Date objects
// become ISO strings, the Prisma `PlanStatus` / `PlanItemOp` enums become
// string unions, the `proposed_fields` / `patch` JSON columns become typed
// objects). The 7.4.5 plan-detail + 7.4.13 plans-list UIs bind to these.

/** Wire form of the Prisma `PlanStatus` enum. */
export type PlanStatusDto = 'generating' | 'planned' | 'approved' | 'declined';

/** Wire form of the Prisma `PlanItemOp` enum. */
export type PlanItemOpDto = 'add' | 'modify' | 'remove';

/**
 * The proposed fields of an `add` PlanItem — the new node's values, which live
 * HERE until materialize (no WorkItem exists yet). `kind` defaults to `task`
 * (a standalone leaf) when omitted; `parentRef` (on the PlanItem) decides the
 * tree placement. All optional except a title.
 */
export interface PlanItemProposedFields {
  title: string;
  kind?: string;
  descriptionMd?: string | null;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
}

/**
 * The sparse patch of a `modify` PlanItem — only the CHANGED fields (the OLD
 * side of each diff is read live from the target at materialize). The edge
 * changes carry refs (a real work-item id or an intra-plan temp-ref).
 */
export interface PlanItemPatch {
  title?: string;
  descriptionMd?: string | null;
  priority?: string | null;
  type?: string | null;
  blockedByAdd?: string[];
  blockedByRemove?: string[];
}

/** One proposed operation in a plan, as the API returns it. */
export interface PlanItemDto {
  id: string;
  op: PlanItemOpDto;
  /** `null` for an un-materialized `add`; the target/created id otherwise. */
  workItemId: string | null;
  proposedFields: PlanItemProposedFields | null;
  patch: PlanItemPatch | null;
  parentRef: string | null;
  blockedByRefs: string[];
  baseRevision: string | null;
  createdAt: string;
}

/**
 * A plan as the API returns it (list row). The lifecycle timestamps + decider
 * ARE the history surface (when planned / when decided / by whom). `itemCount`
 * is the number of bundled PlanItems.
 */
export interface PlanDto {
  id: string;
  projectId: string;
  status: PlanStatusDto;
  title: string | null;
  summary: string | null;
  sourceJobId: string | null;
  itemCount: number;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
  decidedById: string | null;
}

/** A plan plus its bundled proposal items (the detail view). */
export interface PlanWithItemsDto extends PlanDto {
  items: PlanItemDto[];
}

/** A cursor-paginated page of plans, newest first. */
export interface PlanListPageDto {
  plans: PlanDto[];
  /** Opaque cursor for the next page, or `null` when the last page is reached. */
  nextCursor: string | null;
}

/** Input to `plansService.createPlan`. */
export interface CreatePlanInput {
  title?: string | null;
  summary?: string | null;
  sourceJobId?: string | null;
}

/** A single proposed operation appended via `plansService.addProposals`. */
export interface ProposalInput {
  op: PlanItemOpDto;
  /** `modify` / `remove`: the existing target work-item id. Omitted for `add`. */
  workItemId?: string | null;
  /** `add` only. */
  proposedFields?: PlanItemProposedFields | null;
  /** `modify` only. */
  patch?: PlanItemPatch | null;
  /**
   * `add` / edge changes: the parent ref — a real work-item id, or an
   * intra-plan temp-ref `planItem:<planItemId>` pointing at another `add` in
   * this same plan (resolved at materialize).
   */
  parentRef?: string | null;
  /** `add` / edge changes: blocked-by refs (real ids or intra-plan temp-refs). */
  blockedByRefs?: string[];
  /** `modify` / `remove`: the target's revision the change was computed against. */
  baseRevision?: string | null;
}

/** Options for `plansService.listPlans`. */
export interface ListPlansOptions {
  cursor?: string | null;
  limit?: number;
}

// --- Plan staleness (Story 7.21 · MOTIR-1340) -------------------------------
// Computed at REVIEW time from the CURRENT work-item tree + the plan's
// `plannedAt`. The committed tree can change between when a plan is generated
// and when the user reviews it, so a proposed item can DRIFT: its parent was
// archived, new siblings appeared under its parent (its build-sequence context
// is outdated), a blocker it references was removed, or — for modify/remove —
// the target changed since the patch's `baseRevision`. A PURE READ that WARNS;
// it NEVER blocks approve. The 7.4.5 plan-detail (MOTIR-847) + 7.21.1 plans-list
// (MOTIR-1338) UIs bind to these.

/** The reason a proposed PlanItem is flagged stale. A REASON LIST (not a
 *  boolean) so a single item can carry several, and the set is EXTENSIBLE as
 *  the rule set grows — `add` items get the structural reasons; `modify`/`remove`
 *  items get `base_revision_drift`. */
export type StaleReasonCode =
  | 'parent_removed'
  | 'siblings_added'
  | 'blocker_removed'
  | 'base_revision_drift';

/** One staleness reason, carrying the specifics the review UI shows. */
export type StaleReason =
  /** `add`: the proposal's (real) parent is archived/deleted — it would be
   *  orphaned on approve. */
  | { code: 'parent_removed'; parentId: string }
  /** `add`: the parent gained these children AFTER `plannedAt` that the
   *  proposal has no dependency relation with — its build-sequence context is
   *  outdated. */
  | { code: 'siblings_added'; siblingIds: string[] }
  /** `add`: these (real) `blocked_by` targets of the proposal are now
   *  archived/deleted — a dangling dependency. */
  | { code: 'blocker_removed'; blockerIds: string[] }
  /** `modify`/`remove`: the target changed since the patch's `baseRevision`
   *  (`edited`), was `archived`, or is `missing` (hard-deleted) — applying the
   *  patch may conflict with a newer edit. */
  | { code: 'base_revision_drift'; change: 'edited' | 'archived' | 'missing' };

/** One proposed PlanItem's staleness verdict. `stale === reasons.length > 0`. */
export interface PlanItemStalenessDto {
  /** The PlanItem this verdict concerns — the stable key (an un-materialized
   *  `add` has no `workItemId`). */
  planItemId: string;
  /** The target/parent work item the verdict concerns; `null` for an `add`
   *  (it has no real target until materialize). */
  workItemId: string | null;
  stale: boolean;
  reasons: StaleReason[];
}

/** A plan's staleness verdict — per-item reasons + a roll-up `stale` flag. A
 *  plan whose tree is unchanged since `plannedAt` returns all-clear
 *  (`stale: false`, every item with no reasons). */
export interface PlanStalenessDto {
  planId: string;
  stale: boolean;
  items: PlanItemStalenessDto[];
}
