// DTOs for the work-item endpoints + surfaces. These define EXACTLY what
// crosses the HTTP / Server-Action boundary — no Prisma model leaks. The
// service layer (1.4.4) returns these, never raw Prisma rows.
//
// Wire-safe scalar choices: enums are string-literal unions (mirroring the
// Prisma enum labels, but defined here so the DTO module stays Prisma-free);
// `DateTime` becomes an ISO-8601 `string`; the `Decimal` position becomes a
// `string` (a fractional-index key is already a string and Decimals don't
// JSON-serialize losslessly as numbers). The mapper owns those conversions.

import type { WorkflowDto } from './workflows';
import type { RelationshipKind } from './workItemLinks';
import type { LabelDto } from './labels';

export type WorkItemKindDto = 'epic' | 'story' | 'task' | 'bug' | 'subtask';
export type WorkItemPriorityDto = 'lowest' | 'low' | 'medium' | 'high' | 'highest';
export type WorkItemExplanationSourceDto = 'user_authored' | 'ai_draft' | 'user_edited';

/**
 * The full work-item shape for the detail view. Carries both content axes
 * (descriptionMd / explanationMd) and the explanation provenance enum so the
 * UI can render the "AI-drafted — review me" badge.
 */
export interface WorkItemDto {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  descriptionMd: string | null;
  explanationMd: string | null;
  explanationSource: WorkItemExplanationSourceDto;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  /**
   * The agile STORY-POINT estimate (Story 4.3 · Subtask 4.3.3) — a separate
   * numeric estimate from `estimateMinutes` (TIME). Null = unestimated. The
   * project's `estimationStatistic` config picks which of the two the planning
   * surfaces display + the roll-ups sum. The `Decimal(6, 2)` column is mapped
   * to a wire-safe `number` here.
   */
  storyPoints: number | null;
  position: string;
  /**
   * The sprint this issue is committed to, or null when it sits in the backlog
   * (Subtask 4.1.4). Lets an association mutation's result describe the new
   * placement without a re-fetch.
   */
  sprintId: string | null;
  /**
   * The global backlog/sprint rank — the opaque fractional-index ordering
   * within the backlog AND a sprint (Subtask 4.1.4). Orthogonal to `position`
   * (which orders the issue TREE). Null only on a row predating the 4.1.1
   * backfill (none in practice).
   */
  backlogRank: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The lighter shape for list / tree views — just what a row renders (kind
 * icon, identifier, title, assignee avatar, status badge) plus the tree
 * wiring (parentId, position). Omits the heavy Markdown content fields so a
 * list query doesn't ship two `@db.Text` blobs per row.
 */
export interface WorkItemSummaryDto {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  position: string;
  /**
   * The TIME estimate in whole minutes (Story 2.3.6) + the agile STORY-POINT
   * estimate (Story 4.3.4) — both nullable, both carried on the summary so the
   * inline `EstimateBadge` can render whichever the project's
   * `estimationStatistic` selects on a backlog / sprint row without a re-fetch.
   * (The backlog reads full work-item rows, so adding these is free.)
   */
  estimateMinutes: number | null;
  storyPoints: number | null;
  archivedAt: string | null;
}

/**
 * The aggregate read backing the issue DETAIL page (Story 2.4 · Subtask 2.4.1).
 * One service call assembles everything the page renders in a single round-trip:
 * the work item, its full ANCESTOR chain (root→self, backing the parent
 * breadcrumb — 2.4.3) + its immediate parent (the rail's Parent field — 2.4.2)
 * + direct children (the child list — 2.4.3), its blocked-by / blocks
 * dependency links resolved to summaries (the relationships panel + readiness
 * badge — 2.4.5), and the project's workflow (the status control's
 * legal-transition source — 2.4.4). `ancestors` is ordered root→self and
 * EXCLUDES the item itself (a top-level item has `ancestors: []`); `parent` is
 * the immediate parent, kept as its own field so the 2.4.2 rail need not
 * re-derive it. `blockedBy` = items THIS item is blocked by; `blocks` = it blocks.
 * Each relationship group is a {@link RelationshipLinkDto} — the linked item
 * summary PLUS the `work_item_link.id` of the edge, so the 2.4.9 inline remove
 * can target the exact link without re-deriving it.
 */
export interface RelationshipLinkDto {
  /** The `work_item_link.id` of THIS edge — what `unlinkWorkItems` deletes. */
  linkId: string;
  item: WorkItemSummaryDto;
}

export interface IssueDetailDto {
  item: WorkItemDto;
  ancestors: WorkItemSummaryDto[];
  parent: WorkItemSummaryDto | null;
  children: WorkItemSummaryDto[];
  blockedBy: RelationshipLinkDto[];
  blocks: RelationshipLinkDto[];
  relatesTo: RelationshipLinkDto[];
  duplicates: RelationshipLinkDto[];
  clones: RelationshipLinkDto[];
  readiness: ReadinessVerdictDto;
  workflow: WorkflowDto;
  /**
   * The issue's labels, name-ordered (Subtask 5.4.2 — rides the detail
   * read's parallel fetch, one bounded query; the 5.4.8 rail card renders
   * these as chips). Bounded in practice by the per-issue cap.
   */
  labels: LabelDto[];
}

/**
 * A readiness verdict for a work item (Subtask 2.4.5 — the first PRODUCTION
 * wiring of 2.2.6's `isReady` / finding #21). `ready` is true iff EVERY
 * `is_blocked_by` blocker has reached a TERMINAL status in ITS OWN project's
 * workflow (`category = done`, so `done` AND `cancelled` count). An item with
 * no blockers is trivially `ready`. `openBlockers` lists the non-terminal
 * blockers (empty when `ready`) so the ready/blocked banner can NAME the reason
 * it's blocked; each is the same `WorkItemSummaryDto` the relationships panel
 * renders, so the page never re-derives which blockers are open. This is the
 * presentational `ReadinessBadge`'s input — Epic 3 boards + Epic 6 reports
 * consume the same verdict shape.
 */
export interface ReadinessVerdictDto {
  ready: boolean;
  openBlockers: WorkItemSummaryDto[];
}

/**
 * A row of the subtree projection (Subtask 1.4.4) — the wire shape of
 * `workItemRepository.findSubtree`'s recursive-CTE result. Carries the tree
 * wiring (parentId, position, depth) plus the row-render fields, but NOT the
 * heavy Markdown content (a tree view never renders description/explanation
 * inline). `depth` is 1 for the root passed in, 2 for its children, … so the
 * client can indent without recomputing ancestry.
 */
export interface WorkItemSubtreeDto {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  position: string;
  depth: number;
}

/**
 * The optional filter `workItemsService.getProjectTree` (Subtask 2.5.1, the
 * multi-select facets of the 2.5.4 filter bar) applies to the project forest.
 * Every field is optional; an absent / empty field is "don't filter on this
 * axis", so an all-empty filter ({}) returns the full tree.
 *
 * Each faceted axis is a SET (OR within the facet, AND across facets) — Jira's
 * basic filters, the mirror product, are multi-select, and the filter-bar design
 * (`design/work-items/filter.mock.html`) draws multiple kinds / statuses /
 * assignees selected at once. So `kinds` matches "any of these kinds", `statuses`
 * "any of these status keys", and the assignee facet is the union of
 * `assigneeIds` (specific members) with `includeUnassigned` — the MEANINGFUL
 * "Unassigned" bucket (items with a null `assigneeId`), distinct from an empty
 * assignee facet ("any assignee"). `text` is a single case-insensitive substring
 * matched against BOTH `identifier` and `title`; an empty/whitespace-only string
 * is treated as absent.
 *
 * The matching is context-preserving at the service layer: a node that matches
 * retains its ancestor chain so the tree stays navigable (see `getProjectTree`),
 * rather than a flat `WHERE` that would orphan children.
 */
export interface ProjectTreeFilter {
  kinds?: WorkItemKindDto[];
  statuses?: string[];
  assigneeIds?: string[];
  /** Include items with NO assignee (the "Unassigned" bucket), OR-ed with `assigneeIds`. */
  includeUnassigned?: boolean;
  text?: string;
}

/**
 * A node of the project issue-tree (Subtask 2.5.1) — the wire shape backing
 * the `/issues` list view's tree-table (Story 2.5). Unlike the flat
 * `WorkItemSubtreeDto`, this nests: each node carries its `children` (same
 * `key`-asc order as the roots). Per-row render fields the tree-table shows —
 * `kind` (its type icon hue), `identifier`, `title`, `status` (the status
 * pill), `assigneeId` (the assignee cell) — plus `depth` (1 for roots, for
 * indentation) and `hasChildren` (drives the expand chevron — true iff this
 * node has at least one child IN THE RETURNED forest).
 *
 * `matched` reflects the active filter: it is `true` for a node that itself
 * matched the filter (or for EVERY node when no filter is active), and `false`
 * for a node retained ONLY because a descendant matched — those ancestor rows
 * render muted/non-matching so the tree stays navigable without pretending the
 * ancestor was a hit. `hasChildren` and `children` are always consistent
 * (`hasChildren === children.length > 0`).
 */
export interface WorkItemTreeNodeDto {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  // The remaining core properties the list row shows alongside status/assignee
  // (the same fields the detail page's core-fields panel carries): priority,
  // reporter, due date, estimate. `reporterId` is always set; `dueDate` is a
  // wire-safe ISO-8601 string (or null); `estimateMinutes` is whole minutes.
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  /** The agile STORY-POINT estimate (Story 4.3.4) — the inline `EstimateBadge`
   *  renders it (or the time estimate / nothing) per the project statistic. */
  storyPoints: number | null;
  /** ISO-8601 last-modified stamp — the `expectedUpdatedAt` an inline edit
   *  (Subtask 2.5.5) submits for optimistic concurrency on `updateIssueAction`. */
  updatedAt: string;
  depth: number;
  hasChildren: boolean;
  matched: boolean;
  children: WorkItemTreeNodeDto[];
}

/**
 * One row of the flat, sortable List view (Subtask 2.5.8) — the same per-item
 * render fields as a tree node, but WITHOUT the tree metadata (`depth` /
 * `hasChildren` / `matched` / `children`). The List is the project's issues
 * un-nested and ordered by the active sort, so there is no hierarchy to carry.
 * `workItemsService.getProjectIssuesList` returns these already sorted; the
 * route shapes them into the SAME `IssueRowData` the tree row uses, so both
 * views render identical cells.
 */
export interface WorkItemListItemDto {
  id: string;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  /** The agile STORY-POINT estimate (Story 4.3.4) — rendered by the inline
   *  `EstimateBadge` in the List view's Points column. */
  storyPoints: number | null;
  /** ISO-8601 last-modified stamp — the `expectedUpdatedAt` an inline edit
   *  (Subtask 2.5.5) submits for optimistic concurrency on `updateIssueAction`.
   *  `WorkItemTreeRowDto` inherits it for the lazy Tree's inline edits. */
  updatedAt: string;
}

/**
 * One server-paged page of the flat List (Subtask 2.5.12, finding #57): the
 * page's `items` (≤ `pageSize`), the `total` count of the CURRENTLY FILTERED set
 * (so the "1–50 of N" range tracks the 2.5.4 filter), the 1-based `page` (already
 * clamped to the last page when the request overshot), and the `pageSize`
 * constant. The List is `LIMIT/OFFSET`-paged — it never ships the whole backlog.
 */
export interface PagedIssueListDto {
  items: WorkItemListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One node of a LAZY tree level (Subtask 2.5.13, finding #57) — the same render
 * fields as a flat List item PLUS `parentId` (placement) and `hasChildren`
 * (drives the expand chevron without pre-loading the subtree). Returned by
 * `listRootIssues` / `listChildIssues`; the client (2.5.14) fetches one level at
 * a time on expand rather than the whole forest.
 */
export interface WorkItemTreeRowDto extends WorkItemListItemDto {
  parentId: string | null;
  hasChildren: boolean;
}

/**
 * One page of a lazy tree level: the level's rows + `hasMore` (another page
 * exists — drives "Load more children") + `total` (the level's FULL child
 * count, regardless of paging). `hasMore` is the `take + 1` probe; `total` is a
 * cheap COUNT the tree render (2.5.14) needs for an honest `aria-setsize` (a row
 * announces "19 of 128" even when only a window is loaded) + the "Showing 50 of
 * 128" affordance.
 */
export interface TreeLevelDto {
  rows: WorkItemTreeRowDto[];
  hasMore: boolean;
  total: number;
}

/**
 * Input to `workItemsService.createWorkItem` (Subtask 1.4.4). The reporter is
 * taken from the ServiceContext (`ctx.userId`), and key / identifier /
 * position are allocated by the service — so none of those appear here. The
 * caller supplies the content + placement. `kind` and `projectId` are fixed
 * at creation (both immutable thereafter). Omitted optional fields fall back
 * to the column defaults (status='open', priority='medium',
 * explanationSource='user_authored'). `dueDate` is an ISO-8601 string on the
 * wire; the service converts it to a Date.
 */
export interface CreateWorkItemInput {
  projectId: string;
  parentId?: string | null;
  kind: WorkItemKindDto;
  title: string;
  descriptionMd?: string | null;
  explanationMd?: string | null;
  explanationSource?: WorkItemExplanationSourceDto;
  assigneeId?: string | null;
  priority?: WorkItemPriorityDto;
  dueDate?: string | null; // ISO 8601
  estimateMinutes?: number | null;
  /**
   * Create the issue directly INTO a sprint (Subtask 4.2.2 — the backlog /
   * sprint-planning "+ Create issue" row that targets a sprint container). When
   * set, the new issue is born already assigned to this sprint, appended to the
   * sprint's rank tail, in the SAME create transaction — so a quick-create into
   * a sprint is atomic (never created-then-orphaned by a failed follow-up
   * assign). The sprint must exist in the workspace and share the issue's
   * project (the same-project guard `backlogService.assignToSprint` enforces,
   * pulled to create time): a foreign/unknown sprint → `SprintNotFoundError`
   * (404), a cross-project sprint → `CrossProjectSprintAssignmentError` (422).
   * Omitted/null → the issue is born in the backlog (`sprintId IS NULL`),
   * unchanged from Story 1.4 / 4.1.4.
   */
  sprintId?: string | null;
  /**
   * Links to create ATOMICALLY with the issue (Subtask 2.4.10 — the create
   * modal's "Linked issues" section). Each entry is the user-facing
   * (relationship, target) pair — NOT a directed storage edge — because at
   * create time the new item has no id yet, so the from/to direction can't be
   * resolved by the caller. The service maps each via `relationshipToLink`
   * once the row exists (the single source of truth for the `blocks` flip),
   * and writes the `work_item_link` rows inside the same transaction as the
   * item insert (issue + links commit or roll back together). Omitted/empty →
   * a plain create, unchanged from 1.4.4.
   */
  links?: CreateWorkItemLinkInput[];
}

/**
 * One pending link collected in the create modal (Subtask 2.4.10): the chosen
 * relationship + the target issue's id. Distinct from {@link LinkWorkItemsInput}
 * (the directed `fromId → toId` storage shape) — here the new item's id isn't
 * known until it's created, so the pair stays in the UI's
 * {@link RelationshipKind} terms and the service resolves direction.
 */
export interface CreateWorkItemLinkInput {
  targetId: string;
  relationship: RelationshipKind;
}

/**
 * Input to `workItemsService.updateWorkItem` (Subtask 1.4.4) — a sparse patch.
 * EVERY field is optional; an absent field (`undefined`) means "leave it
 * untouched", while an explicit `null` clears a nullable column. An empty
 * patch is a no-op (the service returns the current DTO without writing a
 * revision). `projectId` and `kind` are NOT here — both are immutable post-
 * creation. `parentId` IS patchable (a re-parent is validated for same-project
 * + kind before the DB trigger backstops it). `status` is DELIBERATELY ABSENT
 * (Subtask 2.3.6, finding #46): a status change is NOT a free-form patch — it
 * must go through `workItemsService.updateStatus`, the gated 2.2.4 path that
 * validates the transition against the project's workflow. Putting `status`
 * back here re-opens the ungated dual-write hole this Subtask closed. The
 * explanation-source state machine: supplying `explanationMd` while the current
 * source is `ai_draft`, WITHOUT also setting `explanationSource`, auto-
 * transitions the source to `user_edited`.
 */
export interface UpdateWorkItemInput {
  parentId?: string | null;
  // `kind` is now mutable (user directive): changing an issue's type is
  // re-validated against its CURRENT parent and ALL its children via the
  // kind-parent matrix (`assertValidParent`), so a change that would orphan an
  // illegal parent/child pair is rejected (IllegalParentTypeError → 422).
  kind?: WorkItemKindDto;
  title?: string;
  descriptionMd?: string | null;
  explanationMd?: string | null;
  explanationSource?: WorkItemExplanationSourceDto;
  assigneeId?: string | null;
  priority?: WorkItemPriorityDto;
  dueDate?: string | null; // ISO 8601
  estimateMinutes?: number | null;
}

/**
 * Placeholder forward-compatibility type. The work_item_revision table and
 * its mapper land in Subtask 1.4.6 (revision audit). The DTO shape is fixed
 * here now so downstream consumers (Epic 5's activity feed, Epic 7's
 * "what changed since last planning pass") can type against it before the
 * table exists. `diff` mirrors the planned `{field: {from, to}}` JSON shape.
 */
export interface WorkItemRevisionDto {
  id: string;
  workItemId: string;
  changedById: string;
  changedAt: string;
  changeKind: 'created' | 'updated' | 'archived' | 'comment_deleted';
  diff: Record<string, { from: unknown; to: unknown }>;
}
