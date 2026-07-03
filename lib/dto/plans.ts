// DTO types for the AI-planning Plan substrate (Story 7.21 · MOTIR-1336). The
// shape that crosses the API boundary — no Prisma row leaks (Date objects
// become ISO strings, the Prisma `PlanStatus` / `PlanItemOp` enums become
// string unions, the `proposed_fields` / `patch` JSON columns become typed
// objects). The 7.4.5 plan-detail + 7.4.13 plans-list UIs bind to these.

import type { SprintBlockerDto } from '@/lib/dto/sprints';

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
  /**
   * Leaf sizing (MOTIR-1433) — the agile point estimate + the time estimate the
   * **estimation gate** requires on EVERY leaf (subtask / childless bug/task).
   * They live HERE until materialize maps them onto the created WorkItem. Both
   * optional/nullable (a non-leaf `add` carries neither); validated at
   * `addProposals` / `updateProposal` the SAME way the create path validates
   * them (Fibonacci-range points, non-negative integer minutes).
   */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /**
   * AI-drafted explanation (Story 7.4 · MOTIR-850) — the "why this matters" prose
   * the `generate_tree` planner drafts when the project opts in
   * (`Project.aiGenerateExplanations`). Carried HERE through the proposal until
   * materialize maps it onto the created WorkItem's `explanationMd` /
   * `explanationSource`. `explanationSource` is normally `'ai_draft'` (the
   * generator's default); materialize also defaults it to `ai_draft` when an
   * `explanationMd` is present but no source is set. Both optional — a proposal
   * with explanations OFF carries neither. Item-link convention (Story 5.8): a
   * reference to another item in `explanationMd` is a link token
   * (`motir:<id>` / `motir-ref:<tempRef>`), resolved at materialize.
   */
  explanationMd?: string | null;
  explanationSource?: string | null;
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
  /**
   * Leaf sizing re-scope (MOTIR-1532) — the agile point + time estimate a
   * `modify` may change on the target, mirroring the `add` path's
   * `PlanItemProposedFields` sizing. Validated at the proposal boundary the SAME
   * way (`validateStoryPoints` / `validateEstimateMinutes`); applied by
   * `applyModify` with a `work_item_revision` diff cell. Both optional (a modify
   * that doesn't touch sizing carries neither); an explicit `null` CLEARS the
   * estimate. The `modify_node` generation tool offers both, so without them a
   * proposed re-scope would never apply on approve.
   */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
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

/**
 * The editable fields of a proposed `add` (the proposal-edit path, 7.21.6 ·
 * MOTIR-1370). A sparse patch over the `add`'s `proposedFields`: only the keys
 * present are changed; the rest (incl. `executor`) are left untouched. Only an
 * `add` proposal is editable — `modify`/`remove` target existing items. `title`,
 * when present, must be non-empty (the same invariant `addProposals` enforces).
 */
export interface UpdateProposalInput {
  title?: string;
  kind?: string;
  descriptionMd?: string | null;
  type?: string | null;
  priority?: string | null;
  /** Leaf sizing (MOTIR-1433) — patchable on the proposal-edit / deepen path
   *  exactly like the other proposed fields; an explicit `null` clears the
   *  estimate, the same sparse-merge semantics the rest of this input uses. */
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  /** AI-drafted explanation (Story 7.4 · MOTIR-850) — deepenable on the
   *  proposal-edit / generation deepen path exactly like `descriptionMd`; an
   *  explicit `null` clears it. Sparse-merged into the `add`'s `proposedFields`
   *  (`mergeProposedFields`). `explanationSource` is not deepened here —
   *  materialize defaults it to `ai_draft` when an explanation is present. */
  explanationMd?: string | null;
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

/**
 * Whether a WHOLE plan is finishable once it materializes (Subtask MOTIR-1550) —
 * the FOREST analogue of {@link import('./workItems').WorkItemValidityDto} (the
 * single-subtree rule) and {@link import('./sprints').SprintValidityDto} (the
 * sprint rule). The containing set is the ENTIRE projection (every projected node
 * under any projected root — real roots + `add`s with a null parentRef), so a
 * `blocked_by` edge that crosses two sibling roots (a story under epic B gated by
 * a story under epic A, both materializing together) is SATISFIED — the single-
 * subtree rule iterated per-root would false-positive it. VALID ⟺ for every
 * not-done node in the projected forest, every `blocked_by` dependency is IN the
 * forest, or (under `loose`) `done`; `blockers` names each residual gate — in
 * practice an out-of-projection (e.g. cross-project) not-done blocker, or a
 * `done`-but-out-of-forest one under `tight`. The `generate_tree` /replan worker
 * (MOTIR-1398) runs this as its pre-commit post-condition over the multi-root
 * epic forest it proposes.
 */
export interface PlanValidityDto {
  planId: string;
  valid: boolean;
  blockers: SprintBlockerDto[];
}
