// DTOs for the work-item endpoints + surfaces. These define EXACTLY what
// crosses the HTTP / Server-Action boundary — no Prisma model leaks. The
// service layer (1.4.4) returns these, never raw Prisma rows.
//
// Wire-safe scalar choices: enums are string-literal unions (mirroring the
// Prisma enum labels, but defined here so the DTO module stays Prisma-free);
// `DateTime` becomes an ISO-8601 `string`; the `Decimal` position becomes a
// `string` (a fractional-index key is already a string and Decimals don't
// JSON-serialize losslessly as numbers). The mapper owns those conversions.

import type { FilterAst } from '@/lib/filters/ast';
import type { WorkflowDto } from './workflows';
import type { RelationshipKind } from './workItemLinks';
import type { LabelDto } from './labels';
import type { ComponentDto } from './components';
import type { CustomFieldWithValueDto } from './customFieldValues';

export type WorkItemKindDto = 'epic' | 'story' | 'task' | 'bug' | 'subtask';
export type WorkItemPriorityDto = 'lowest' | 'low' | 'medium' | 'high' | 'highest';
export type WorkItemExplanationSourceDto = 'user_authored' | 'ai_draft' | 'user_edited';
/**
 * The work-item TYPE — the NATURE of executable work (Story 2.7). A FIXED
 * ten-member set, in the canonical order the 2.7.2 ADR
 * (docs/decisions/work-item-type-taxonomy.md) froze, mirroring the
 * `WorkItemType` Prisma enum 1:1. DISTINCT from `kind`; carried only on
 * executable leaves (task / subtask / bug) — epics/stories + legacy rows are
 * `null`. Fixed (not free text) so Story 7.6's per-type prompt generator is a
 * TOTAL function over it and the 2.7.6 filter facet is a closed set.
 */
export type WorkItemTypeDto =
  | 'code'
  | 'design'
  | 'test'
  | 'content'
  | 'research'
  | 'review'
  | 'decision'
  | 'deploy'
  | 'manual'
  | 'chore';
/**
 * WHO executes a piece of work (Story 2.7) — mirrors the `Executor` Prisma
 * enum. Seeded from the type→executor default map (`lib/issues/executorDefaults.ts`)
 * when a type is first chosen, and overridable.
 */
export type ExecutorDto = 'coding_agent' | 'human';

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
   * The NATURE of the work (Story 2.7) — one of the ten `WorkItemTypeDto`
   * members, or `null` on a container kind (epic/story) or an untyped leaf.
   * DISTINCT from `kind`.
   */
  type: WorkItemTypeDto | null;
  /**
   * WHO executes the work (Story 2.7) — `coding_agent` | `human`, seeded from
   * the type→executor default when a type is chosen and overridable. `null`
   * when no type is set.
   */
  executor: ExecutorDto | null;
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
  /**
   * Epic-level privacy (Story 6.14 · Subtask 6.14.3). When `true` on an
   * EPIC-kind item, a public/non-member viewer of a public project sees the
   * epic ROW but NOT its children or aggregate tells (the server-side exclusion
   * lands in 6.14.4). A no-op marker on any other kind / non-public project.
   * Carried on the internal (member/admin) DTO so the 6.14.7 admin control can
   * seed its toggle from the authoritative value.
   */
  publicChildrenHidden: boolean;
  /**
   * The integration branch this item's work currently sits on (Story 7.8 ·
   * Subtask 7.8.11), or `null`. NON-NULL ⇔ the item is integrated-awaiting-review
   * (status moved to `in_review` via `mark_integrated`): its work is mergeable,
   * so it unblocks dependents (the integrated-dep readiness rule) and the issue
   * detail surfaces it as a read-only line. CLEARED back to null the moment the
   * item reaches a `done`-category status. Carried on the DTO so the issue detail
   * + the MCP tool results render the authoritative value.
   */
  sessionBranch: string | null;
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
  /**
   * The issue's components, name-ordered (Subtask 5.4.3 — rides the detail
   * read's parallel fetch, one bounded query; the 5.4.8 rail card renders
   * these as chips). Bounded by the project's admin-curated taxonomy.
   */
  components: ComponentDto[];
  /**
   * The project's custom-field definitions in position order, each with its
   * option set and THIS issue's resolved value (Subtask 5.3.3 — one bounded
   * query in the detail read's parallel fetch, ≤50 by the project cap).
   * Fields the issue holds no value for ship with `value: null` — the 5.3.7
   * rail collapses those behind "Show more fields".
   */
  customFields: CustomFieldWithValueDto[];
  /**
   * How many people watch this issue — the header eye-count (Subtask 5.4.4;
   * two point reads riding the detail read's parallel fetch, no extra
   * round-trip). The full roster stays behind the paged watchers route.
   */
  watcherCount: number;
  /** Whether the CALLER watches it — the eye control's filled/outline state. */
  viewerIsWatching: boolean;
  /**
   * Who archived this item (Story 2.9 · Subtask 2.9.6) — present ONLY when the
   * item is archived (`item.archivedAt != null`), resolved from the latest
   * `'archived'` revision (the same source as the 2.9.3 list view). `null` for
   * an active item, OR when the item is archived but no `'archived'` revision
   * resolved an actor (defensive — `item.archivedAt` carries the WHEN
   * regardless). The detail page's archived banner names the WHO from this and
   * the WHEN from `item.archivedAt`.
   */
  archivedBy: ArchivedByActorDto | null;
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
  /** The work-item TYPE facet (the 6.15 quick-filter facet) — match any of these
   * `WorkItemType` members. */
  types?: WorkItemTypeDto[];
  /** Include items with NO work type (the "Untyped" null bucket), OR-ed with `types`. */
  includeUntyped?: boolean;
  statuses?: string[];
  assigneeIds?: string[];
  /** Include items with NO assignee (the "Unassigned" bucket), OR-ed with `assigneeIds`. */
  includeUnassigned?: boolean;
  text?: string;
  /**
   * The advanced filter builder's AST (Story 6.1 · 6.1.1) — validated against
   * the operator registry at the service boundary (typed 422s on unknown
   * field/operator ids or bad values), AND-ed with the facet axes above. The
   * facets remain the quick path; this is the superseding rich shape.
   */
  ast?: FilterAst;
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
 * The actor who archived a work item (Subtask 2.9.2), resolved from the latest
 * `'archived'` revision — Avatar · name, the same shape the activity feed and
 * comment author use. `name` / `image` are nullable so a deleted-but-restricted
 * referent renders a "former member" fallback instead of crashing the view; the
 * `id` is always kept. The whole object is `null` when no `'archived'` revision
 * resolved an actor.
 */
export interface ArchivedByActorDto {
  id: string;
  name: string | null;
  image: string | null;
}

/**
 * One row of the ARCHIVED items view (Story 2.9 · Subtask 2.9.2) — a flat List
 * item PLUS the archive metadata the management surface shows and restores from:
 * the `archivedAt` ISO stamp (the list's sort key) and the `archivedBy` actor.
 * Archived items are a FLAT set (archive is single-node — no cascade), so there
 * is no tree metadata, exactly like {@link WorkItemListItemDto}.
 */
export interface ArchivedWorkItemDto extends WorkItemListItemDto {
  /** ISO-8601 soft-delete instant — the list is ordered most-recent first. */
  archivedAt: string;
  /** Who archived it (latest `'archived'` revision), or `null` if unresolved. */
  archivedBy: ArchivedByActorDto | null;
}

/**
 * One server-paged page of the archived view (Subtask 2.9.2) — the same paging
 * envelope as {@link PagedIssueListDto}: the page's `items` (≤ `pageSize`), the
 * `total` archived count, the 1-based `page` (clamped to the last page when the
 * request overshot), and the `pageSize`. LIMIT/OFFSET-paged — never the whole
 * archive at once.
 */
export interface PagedArchivedWorkItemsDto {
  items: ArchivedWorkItemDto[];
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
   * The story-point estimate (Story 4.3 · exposed on create in 7.8.21). The
   * single `storyPoints` Decimal(6, 2) column — distinct from the TIME estimate
   * (`estimateMinutes`). Validated by the shared `validateStoryPoints` (finite,
   * non-negative, ≤ 9999.99, ≤ 2 decimals) — the SAME rule the UI estimation
   * surface (`estimationService.setEstimate`) enforces, so the agent surface is
   * never stricter or looser than the human one. Omitted → null (unestimated,
   * the column default); `null` is also accepted to be explicit.
   */
  storyPoints?: number | null;
  /**
   * The work-item TYPE (Story 2.7) — leaf-only: supplying it on an epic/story
   * kind is rejected with `TypeNotAllowedOnKindError` (422). When a `type` is
   * supplied WITHOUT an explicit `executor`, the service seeds `executor` from
   * the type→executor default map (`defaultExecutorForType`). Omitted → the
   * column stays null (an untyped leaf), unchanged from pre-2.7.
   */
  type?: WorkItemTypeDto | null;
  /**
   * WHO executes the work (Story 2.7). Overrides the type→executor default
   * when supplied alongside `type`. Setting it on an epic/story kind (or with
   * no type) follows the same leaf-only rule as `type`.
   */
  executor?: ExecutorDto | null;
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
  /**
   * Components to assign ATOMICALLY with the issue (Subtask 5.4.3 — the
   * create modal's Components picker). Every id must resolve to a component
   * of the SAME project (unknown / cross-workspace → 404 `ComponentNotFoundError`,
   * another project's → `CrossProjectComponentError` 422), pre-checked before
   * the create transaction so a denied create never burns a work-item key;
   * the join rows are written inside the create transaction (issue +
   * components commit or roll back together, the links rule). Carrying
   * components also arms the verified at-create default-assignee rule: an
   * issue created with components and NO assignee takes the default assignee
   * of its first-alphabetical component that has one (create-time only —
   * later component changes never touch the assignee). Omitted/empty → a
   * plain create.
   */
  componentIds?: string[];
  /**
   * Triage intake (Story 6.11 · Subtask 6.11.4). When set, the new work_item is
   * born in the TRIAGE inbox: the service stamps `triagedAt = now()` and records
   * `submittedByUserId` (the human who submitted it). A triage item is excluded
   * from EVERY normal read — the tree, every board, every list, the ready set,
   * and search — until an admin promotes it (6.11.5); the triage-queue read is
   * the only read that returns it. Created through the SAME `createWorkItem`
   * authority as an ordinary item (one create = one transaction), so a triage
   * submission still allocates a key, records its `created` revision, and runs
   * the kind-parent + access gates. The triage `triageService.createSubmission`
   * caller passes a parentless `bug`/`task` and this marker; omitted → an
   * ordinary create, unchanged.
   */
  triage?: { submittedByUserId: string };
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
  /**
   * Patch the story-point estimate (Story 4.3 · exposed on this patch in
   * 7.8.21). Set / change / clear (`null`) the single `storyPoints`
   * Decimal(6, 2) column — distinct from the TIME estimate (`estimateMinutes`).
   * Validated by the shared `validateStoryPoints` (finite, non-negative,
   * ≤ 9999.99, ≤ 2 decimals → `InvalidEstimateError`), the SAME rule the UI
   * estimation path (`estimationService.setEstimate`) enforces. Recorded in the
   * revision diff as `{ storyPoints: { from, to } }` (numeric, not Decimal),
   * sharing the single 'updated' revision with any other field in the patch.
   */
  storyPoints?: number | null;
  /**
   * Patch the work-item TYPE (Story 2.7). Leaf-only — set/changing it on an
   * epic/story is rejected (`TypeNotAllowedOnKindError`, 422). An explicit
   * `null` clears the type. SEED-IF-ABSENT semantics for the executor (the same
   * rule create uses): when `type` is patched to a non-null value, `executor`
   * is NOT supplied, AND the row currently has no executor, the service seeds
   * `executor` from `defaultExecutorForType` — the "first chosen" case from the
   * 2.7.2 ADR. If the row already HAS an executor (a prior override), a bare
   * `type` change never clobbers it.
   */
  type?: WorkItemTypeDto | null;
  /** Patch the executor (Story 2.7) — same leaf-only rule as `type`. */
  executor?: ExecutorDto | null;
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
  changeKind: 'created' | 'updated' | 'archived' | 'unarchived' | 'comment_deleted' | 'deleted';
  diff: Record<string, { from: unknown; to: unknown }>;
}

/** The per-item outcome of a `complete_session` bulk close-out (Subtask 7.8.11):
 *  `completed` (transitioned to done), `already_done` (was already in a done
 *  status — a no-op, idempotent), or `failed` (the move was rejected — e.g. an
 *  illegal transition or an unknown done status in a custom workflow; `reason`
 *  carries the typed error message). */
export type CompleteSessionOutcome = 'completed' | 'already_done' | 'failed';

export interface CompleteSessionItemResultDto {
  /** The `PROD-<n>` identifier of the recorded item. */
  key: string;
  outcome: CompleteSessionOutcome;
  /** Present (and only present) on `failed` — the typed error's message. */
  reason?: string;
}

/**
 * The result of `complete_session(sessionBranch)` (Subtask 7.8.11) — the bulk
 * close-out after a human merges the session PR. Every work item recorded on the
 * branch is transitioned to done (clearing the branch) in ONE transaction; the
 * per-item `results` surface partial failures (an item whose workflow has no
 * legal path to done) without rolling back the items that DID complete. The
 * legal-transition check runs before any write, so a rejected item leaves the
 * transaction healthy for the rest.
 */
export interface CompleteSessionResultDto {
  sessionBranch: string;
  results: CompleteSessionItemResultDto[];
}

/**
 * The cascade impact of a PERMANENT delete (Story 2.8 · Subtask 2.8.7) — the
 * figures the delete-confirm dialog (2.8.4) reads BEFORE the user confirms, so
 * the irreversible cascade is named in words (not colour alone). `totalCount` is
 * the number of rows the delete removes — the root PLUS every descendant — i.e.
 * the "Delete N items" button magnitude; `descendantCount` is `totalCount − 1`;
 * `byKind` is the per-kind breakdown of the DESCENDANTS only (e.g.
 * `{ subtask: 5, task: 1, bug: 1 }`), the zero-count kinds omitted. A leaf item
 * returns `{ totalCount: 1, descendantCount: 0, byKind: {} }`. This is a READ —
 * the destructive write is `deleteWorkItem` (2.8.2).
 *
 * `liveDescendantCount` + `liveByKind` (Story 2.9 · Subtask 2.9.9) split out the
 * NON-archived descendants the cascade would ALSO destroy. Motir's archive is
 * single-node (archiving a parent never archives its children —
 * `workItemsService.archiveWorkItem`), so an archived parent can still own LIVE
 * descendants on the active boards/lists, and `deleteWorkItem` cascades the WHOLE
 * subtree (`findSubtree`) — permanently destroying those live items too. The
 * archived-item delete-confirm (2.9.10) warns about exactly that count.
 * `liveDescendantCount` is a strict subset of `descendantCount` (the root is
 * excluded from both; archived descendants are in `descendantCount`/`byKind` but
 * not here); `liveByKind` is its per-kind breakdown, zero-count kinds omitted.
 */
export interface WorkItemDeletePreviewDto {
  totalCount: number;
  descendantCount: number;
  byKind: Partial<Record<WorkItemKindDto, number>>;
  liveDescendantCount: number;
  liveByKind: Partial<Record<WorkItemKindDto, number>>;
}
