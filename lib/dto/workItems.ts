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
  position: string;
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
 */
export interface IssueDetailDto {
  item: WorkItemDto;
  ancestors: WorkItemSummaryDto[];
  parent: WorkItemSummaryDto | null;
  children: WorkItemSummaryDto[];
  blockedBy: WorkItemSummaryDto[];
  blocks: WorkItemSummaryDto[];
  workflow: WorkflowDto;
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
 * The optional filter `workItemsService.getProjectTree` (Subtask 2.5.1) applies
 * to the project forest. Every field is optional; an absent field is "don't
 * filter on this axis", so an all-absent filter ({}) returns the full tree.
 * `assigneeId: null` is a MEANINGFUL value — it filters to UNASSIGNED items
 * (the list-view "Unassigned" option), distinct from `assigneeId` absent
 * ("any assignee"). `text` is a case-insensitive substring matched against
 * BOTH `identifier` and `title`; an empty/whitespace-only string is treated
 * as absent. The matching is context-preserving at the service layer: a node
 * that matches retains its ancestor chain so the tree stays navigable (see
 * `getProjectTree`), rather than a flat `WHERE` that would orphan children.
 */
export interface ProjectTreeFilter {
  kind?: WorkItemKindDto;
  status?: string;
  assigneeId?: string | null;
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
  assigneeId: string | null;
  depth: number;
  hasChildren: boolean;
  matched: boolean;
  children: WorkItemTreeNodeDto[];
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
  changeKind: 'created' | 'updated' | 'archived';
  diff: Record<string, { from: unknown; to: unknown }>;
}
