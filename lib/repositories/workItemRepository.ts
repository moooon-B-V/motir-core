import {
  Prisma,
  type EstimationStatistic,
  type WorkItem,
  type WorkItemKind,
  type WorkItemPriority,
  type WorkItemType,
} from '@prisma/client';
import { db } from '@/lib/db';
import type { BuiltInFilterFieldId, FilterAst, FilterCondition } from '@/lib/filters/ast';
import {
  resolveFilterAst,
  type CustomFieldFilterType,
  type FilterFieldDef,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import { UnknownFilterOperatorError } from '@/lib/filters/errors';
import type { DistributionGroupBy } from '@/lib/reports/statisticTypes';
import type { IssueSort, IssueSortColumn } from '@/lib/issues/issueListView';
import { READY_KIND_RANK, type ReadyCursor } from '@/lib/workItems/readyFilter';
import {
  DepthLimitExceededError,
  IllegalParentTypeError,
  ParentCycleError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';

// Work-item repository — single Prisma operations on the `work_item` table.
// Writes require `tx` (compile-time guarantee they run in a transaction);
// pure read paths use the `db` singleton (with an optional `tx` for reads
// that run inside a transaction). No business logic, no transactions, no DTO
// mapping here — those belong in workItemsService (Subtask 1.4.4).
//
// The DB-layer triggers (prisma/sql/work_item_triggers.sql) enforce the
// kind-parent matrix, the depth limit, and cycle prevention. On INSERT /
// UPDATE they reject with SQLSTATE 23514 + a message marker; create/update
// translate those markers into the typed errors from lib/workItems/errors.ts
// at this edge, so the service layer never inspects Prisma/Postgres error
// codes (the 4-layer rule). P2002 (unique key/identifier) and P2025 (record
// not found) are translated here too.

/**
 * A row of `findSubtree`'s recursive-CTE result: the work item plus its
 * `depth` (1 = the root passed in, 2 = its children, …). `kind` is cast to
 * text in the query (the enum would otherwise come back as a Prisma enum);
 * `position` is already a text column. This is intentionally NOT a `WorkItem`
 * — it's the raw tree-walk projection.
 */
export interface WorkItemSubtreeRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKind;
  key: number;
  identifier: string;
  title: string;
  status: string;
  position: string;
  depth: number;
}

/**
 * A row of `findProjectForest`'s recursive-CTE result (Subtask 2.5.1): the
 * per-row render fields the tree-table shows (no Markdown blobs), the `depth`
 * (1 = a root) for indentation, and `matched` — whether the row passed the
 * supplied filter (always `true` when no filter is active). The service nests
 * these into `WorkItemTreeNodeDto`s and, under an active filter, prunes to
 * matched-or-has-matched-descendant (the context-preserving ancestor retention
 * — a tree operation, kept out of the single-op repo). `kind` is cast to text
 * in the query so `$queryRaw` returns the plain enum label.
 */
export interface WorkItemForestRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKind;
  /** The leaf's work type (Story 2.7) — the row Type chip (8.8.9); `null` on
   *  containers. Cast to text in the query so `$queryRaw` returns the enum label. */
  type: WorkItemType | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  dueDate: Date | null;
  estimateMinutes: number | null;
  storyPoints: Prisma.Decimal | null;
  updatedAt: Date;
  depth: number;
  matched: boolean;
}

/**
 * A row of `findProjectIssuesFlat`'s flat List read (Subtask 2.5.8): the same
 * per-row render fields as `WorkItemForestRow` minus the tree metadata
 * (`parentId` / `depth` / `matched`) — the List is un-nested, so there is no
 * hierarchy to carry. The service maps these to `WorkItemListItemDto`s.
 */
export interface WorkItemListRow {
  id: string;
  kind: WorkItemKind;
  /** The leaf's work type (Story 2.7) — the row Type chip (8.8.9); `null` on
   *  containers. `WorkItemTreeRow` / `ArchivedWorkItemRow` inherit it. */
  type: WorkItemType | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  dueDate: Date | null;
  estimateMinutes: number | null;
  storyPoints: Prisma.Decimal | null;
  updatedAt: Date;
}

/**
 * One row of a LAZY tree level (Subtask 2.5.13): a single parent's direct
 * children OR the project's roots — paged + sorted. Same render fields as
 * `WorkItemListRow`, plus `parentId` (so the client can place it) and
 * `hasChildren` — an `EXISTS` flag driving the expand chevron WITHOUT
 * pre-loading the subtree (the whole-forest scale fix, finding #57). No `depth`
 * (the client tracks it via expansion) and no `matched` (the lazy path is the
 * UNfiltered tree; a filtered tree still uses `findProjectForest`).
 */
export interface WorkItemTreeRow extends WorkItemListRow {
  parentId: string | null;
  hasChildren: boolean;
}

/**
 * One row of the ARCHIVED list read (Subtask 2.9.2) — the same per-row render
 * fields as `WorkItemListRow` PLUS the two bits the archive-management surface
 * (Story 2.9) needs and that no active-view read carries: the `archivedAt`
 * stamp (the soft-delete instant the list orders by) and the actor who archived
 * it, resolved by the SAME single read from the latest `'archived'` revision
 * (`changedById` + the user's display name / avatar, left-joined). `archivedBy*`
 * is nullable because the revision's author is `onDelete: Restrict` but a future
 * data path could still leave it absent — the mapper degrades to `null` (a
 * "former member" fallback) rather than dropping the row.
 */
export interface ArchivedWorkItemRow extends WorkItemListRow {
  archivedAt: Date;
  archivedById: string | null;
  archivedByName: string | null;
  archivedByImage: string | null;
}

/**
 * One CANDIDATE row of the ready set (Subtask 7.0.2): the FULL `work_item` row
 * (so the `readyMappers` `toReadyItemDto(row: WorkItem, …)` can consume it
 * directly — the 7.0.3 mapper takes a `WorkItem` + resolved context) PLUS the
 * three bits resolved by the SAME single read so the service doesn't re-query:
 * the status `category` (joined from `workflow_status` — the row's `status` is
 * only the key) and the assignee's display name / email / avatar (left-joined
 * from `user`). The service hands `row` + `{ statusCategory, assignee }` to the
 * mapper.
 *
 * It is a CANDIDATE row, not a confirmed ready item: the per-blocker terminal
 * classification (readiness) is computed in the service over a batched
 * `getReadinessForItems` (finding #21 — "terminal" is a per-blocker-project
 * property the single-op repo can't express), then the candidates are filtered
 * to `ready === true`.
 */
export type ReadyCandidateRow = WorkItem & {
  statusCategory: string;
  assigneeName: string | null;
  assigneeEmail: string | null;
  assigneeImage: string | null;
};

/**
 * One row of a ready-set LAYER (Subtask 7.0.13) — a `ReadyCandidateRow` plus
 * `hasChildren`, the bit the top-down traversal needs to decide DESCEND (a
 * planned container) vs COLLECT (a childless, dispatchable leaf). Unlike
 * `findReadyCandidates` (which scanned the whole project's leaves), the layered
 * read fetches one parent level at a time and does NOT pre-filter to
 * `todo`/leaf — the service decides per row — so `statusCategory` is the live
 * category (possibly non-`todo` for a container we still descend into).
 */
export type ReadyLayerRow = ReadyCandidateRow & { hasChildren: boolean };

/**
 * One row of the triage QUEUE read (Subtask 6.11.3) — the FULL `work_item` row
 * (so the mapper consumes its `triagedAt` / `snoozedUntil` columns directly)
 * PLUS the bits the SAME single read resolves so the service doesn't re-query:
 * the status `category` (joined from `workflow_status` — the row's `status` is
 * only the key) and the SUBMITTER's display name / email / avatar (left-joined
 * from `user` on `submittedByUserId`) plus whether that submitter is a member of
 * the item's workspace. Intake is signed-in only (the 2026-06-14 revision,
 * Subtask 6.11.10), so the submitter is always a real account; the inbox derives
 * "member vs public" from `submitterIsMember` (ADR §3).
 */
export type TriageQueueRow = WorkItem & {
  statusCategory: string;
  submitterName: string | null;
  submitterEmail: string | null;
  submitterImage: string | null;
  /**
   * TRUE when `submittedByUserId` is a member of the item's workspace (the
   * in-app report widget); FALSE for a signed-in non-member (Story 6.12's public
   * "Submit a request") or when the item has no recorded submitter. Drives the
   * mapper's member-vs-public `kind`.
   */
  submitterIsMember: boolean;
  /**
   * How many accounts upvoted this request (Story 6.12 · Subtask 6.12.6) — the
   * demand signal the queue sorts by, highest-first. 0 for an item with no
   * public votes (the common case), so a queue with no votes keeps its
   * newest-first order (votes tie at 0 → the `triagedAt`/`id` tiebreak decides).
   */
  voteCount: number;
};

/**
 * The seek-after position the triage-queue cursor decodes to — the last item of
 * the previous page under the queue's `(voteCount DESC, triagedAt DESC, id ASC)`
 * total order (Story 6.12 · Subtask 6.12.6 added the leading vote-count key — the
 * demand signal — ahead of the original newest-first `(triagedAt, id)` tiebreak,
 * so an upvoted request floats up while a zero-vote queue is unchanged).
 * `triagedAt` is the marker timestamp (always non-null for a queue row); `id`
 * breaks the (rare) same-instant tie so paging never skips/repeats a row.
 */
export interface TriageQueueCursor {
  voteCount: number;
  triagedAt: Date;
  id: string;
}

/**
 * One duplicate-detection candidate row (Story 6.12 · Subtask 6.12.5) — a
 * matching active PUBLIC REQUEST plus its upvote count (the demand signal the
 * "upvote this instead" affordance shows). A public request is a project work
 * item of request grammar (`bug` / `task`); the count rides the 6.12.3
 * `PublicRequestVote` join (zero when no votes / before 6.12.6 lands the write).
 */
export type PublicRequestMatchRow = WorkItem & {
  voteCount: number;
};

/**
 * One card of a PUBLIC ROADMAP column (Story 6.12 · Subtask 6.12.7) — the FULL
 * `work_item` row (the public mapper reads only its public-safe fields) PLUS the
 * two bits the SAME single read resolves: `voteCount` (the upvote tally — the
 * demand signal the column orders by, 6.12.6) and `voted` (whether the CURRENT
 * viewer has upvoted this card, so the card paints its voted state on first
 * load; always `false` for a logged-out reader). The vote aggregate + the
 * viewer-vote probe ride the app-layer `projectId` gate + the app connection's
 * RLS-secondary posture, the same way `findTriageQueue` / `countByProject` read
 * `public_request_vote` (finding #26).
 */
export type PublicRoadmapRow = WorkItem & {
  voteCount: number;
  voted: boolean;
};

/**
 * One row of a LAZY level of the PUBLIC work-item TREE (Story 6.14 · Subtask
 * 6.14.10) — a single parent's direct children OR the project's roots, projected
 * to the PUBLIC-safe fields ONLY (no assignee / estimate / story points / due
 * date / reporter — those are never SELECTed, so an internal field cannot leak;
 * the public projection is structural, not a runtime omission). Carries:
 *
 *   - `publicChildrenHidden` — the epic-privacy flag (6.14.4) the mapper reads to
 *     stamp the "this epic is not public" marker on a PRIVATE epic's row.
 *   - `hasChildren` — an `EXISTS` over the node's PUBLICLY-VISIBLE children (the
 *     same `excludeIds` exclusion as the level itself, so a private epic — whose
 *     descendants are all excluded — reports `false`; the placeholder chevron is
 *     driven by `publicChildrenHidden`, not this flag).
 *
 * Same `parentId` + lazy-`hasChildren` shape as the authed {@link WorkItemTreeRow},
 * minus the internal columns.
 */
export interface PublicWorkItemTreeRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKind;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  publicChildrenHidden: boolean;
  hasChildren: boolean;
}

/**
 * The `(voteCount, recency, id)` seek-after position a roadmap column read pages
 * after (Subtask 6.12.7). `voteCount` is the leading sort key; `recency` is the
 * bucket tiebreak — a `Date` (the Submitted column's `triagedAt`) or a `number`
 * (a promoted column's monotonic `key`); `id` breaks the exact tie. The service
 * decodes the opaque cursor token into this typed shape per column.
 */
export interface PublicRoadmapCursor {
  voteCount: number;
  recency: Date | number;
  id: string;
}

/**
 * The whitelisted ORDER-BY expression per sort column (Subtask 2.5.8). The
 * key is a validated `IssueSortColumn` (parsed/clamped in `issueListView`), so
 * the SQL fragment is never derived from raw user input. `assignee`/`reporter`
 * sort by the joined user name (`au`/`ru` in `findProjectIssuesFlat`); `status`
 * by the project workflow's status order (`ws.position`); the rest are
 * `work_item` columns. Total over `IssueSortColumn` (compile-time checked).
 */
const ISSUE_SORT_SQL: Record<IssueSortColumn, Prisma.Sql> = {
  key: Prisma.sql`w."key"`,
  title: Prisma.sql`w."title"`,
  // The Type column (Subtask 8.8.9) — orders by the work_item_type enum's
  // declaration order (NULL-type containers sort last via the NULLS LAST clause).
  type: Prisma.sql`w."type"`,
  priority: Prisma.sql`w."priority"`,
  assignee: Prisma.sql`au."name"`,
  reporter: Prisma.sql`ru."name"`,
  due: Prisma.sql`w."dueDate"`,
  estimate: Prisma.sql`w."estimateMinutes"`,
  points: Prisma.sql`w."storyPoints"`,
  status: Prisma.sql`ws."position"`,
};

/**
 * The roll-up aggregate expression for an estimation `statistic` (Subtask
 * 4.3.3), parameterising the bounded sprint/epic roll-ups so adding the
 * statistic switch is ONE parameter, not three query paths (the durable shape).
 * The `statistic` is a validated Prisma enum (never raw user input), so the
 * branch is a whitelist — the same pattern as `ISSUE_SORT_SQL`. `colOwner` is
 * the alias the points/time column hangs off (`w` for the flat sprint scan, `s`
 * for the recursive subtree CTE). `doneFilter`, when true, scopes the SUM to
 * issues in a `category = 'done'` workflow status via an aggregate `FILTER`
 * (the `ws` join must be present) — used for a sprint's `completed` points.
 * Sums `COALESCE`-to-0 so an all-NULL/empty group returns 0, never NULL.
 */
function pointsAggExpr(
  statistic: EstimationStatistic,
  colOwner: 'w' | 's',
  doneFilter: boolean,
): Prisma.Sql {
  const filter = doneFilter ? Prisma.sql` FILTER (WHERE ws."category" = 'done')` : Prisma.empty;
  if (statistic === 'issue_count') {
    return Prisma.sql`COUNT(*)${filter}`;
  }
  const owner = Prisma.raw(colOwner); // 'w' | 's' — an internal literal, never user input
  const col =
    statistic === 'story_points'
      ? Prisma.sql`${owner}."storyPoints"`
      : Prisma.sql`${owner}."estimateMinutes"`;
  return Prisma.sql`COALESCE(SUM(${col})${filter}, 0)`;
}

export const workItemRepository = {
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<WorkItem | null> {
    const client = tx ?? db;
    return client.workItem.findUnique({ where: { id } });
  },

  /**
   * Acquire a row-level lock on the work item inside the caller's transaction.
   * This is the guarding read for the update / move flow (workItemsService,
   * 1.4.4): lock the row, re-read current state to compute the revision diff +
   * validate the parent move, then write — all serialized against a concurrent
   * mutation of the same row. Without the lock, two transactions could each
   * read the pre-move tree, both pass the cycle/depth trigger on their own
   * stale snapshot, and together corrupt the tree (or clobber each other's
   * field writes — a lost update). Returns null when the id doesn't exist.
   * Read-inside-a-transaction that gates a write → requires `tx` per CLAUDE.md
   * (mirrors userRepository.lockById).
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "work_item" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async findByIdentifier(
    projectId: string,
    identifier: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem | null> {
    const client = tx ?? db;
    return client.workItem.findUnique({
      where: { projectId_identifier: { projectId, identifier } },
    });
  },

  /**
   * Re-derive every work item's denormalized `identifier` for a project after a
   * key change (Story 6.8 · `changeKey`). The identifier is derived data —
   * `<project key>-<key number>` — so a rename is a single in-place bulk UPDATE,
   * NOT a per-row loop and NOT a revision-generating mutation (the `key` number
   * is untouched; only the prefix changes). ONE statement keyed on `projectId`,
   * index-maintained by the `@@unique([projectId, identifier])` index, so it is
   * bounded even on a 10k-issue project — this IS the "re-index", synchronous
   * and atomic, where Jira would kick off a background Lucene job (ours reads the
   * denormalized column, so there is no external index to rebuild). `"key"` is
   * cast to text for the concatenation. Returns the row count. Write → `tx`
   * required (it runs inside the FOR-UPDATE-locked rename transaction).
   */
  async rewriteIdentifiersForProject(
    projectId: string,
    newKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "work_item"
      SET "identifier" = ${newKey} || '-' || "key"::text
      WHERE "projectId" = ${projectId}
    `;
  },

  /**
   * Bulk-read work items by id in a single `IN (...)` round-trip (Subtask
   * 1.4.4). Rows come back in Postgres' arbitrary order — service callers
   * (`getBlockers` / `getBlocking`) re-sort if they need a specific order.
   * This is the N+1-avoidance leg of the blocker/blocking resolution: one
   * link-table query yields the ids, this resolves them all at once.
   * Read-only path → `db` singleton. Empty input short-circuits to `[]` so
   * we never issue a degenerate `IN ()`.
   */
  async findByIds(ids: string[]): Promise<WorkItem[]> {
    if (ids.length === 0) return [];
    return db.workItem.findMany({ where: { id: { in: ids } } });
  },

  /**
   * Resolve many work items by id WITHIN one workspace, INCLUDING archived ones
   * (no `archivedAt` filter) — the batched read behind plan-staleness detection
   * (7.21.3 / MOTIR-1340), which must distinguish "still live" from "archived /
   * gone" for a plan's referenced parents, blockers, and modify/remove targets
   * in ONE round-trip (no N+1). Workspace-scoped (the explicit finding-#26
   * tenant gate, since RLS is inert under the dev/CI superuser) so a cross-tenant
   * id simply doesn't come back. Read-only path → `db` singleton. Empty input
   * short-circuits to `[]` so we never issue a degenerate `IN ()`.
   */
  async findByIdsInWorkspace(ids: string[], workspaceId: string): Promise<WorkItem[]> {
    if (ids.length === 0) return [];
    return db.workItem.findMany({ where: { id: { in: ids }, workspaceId } });
  },

  /**
   * Live (non-archived) children of MANY parents created strictly after a
   * cutoff, in ONE query — the batched read behind plan-staleness `siblings_added`
   * (7.21.3 / MOTIR-1340): a proposed `add` is stale when its parent gained a
   * child AFTER the plan's `plannedAt` that the proposal has no dependency
   * relation with. Mirrors {@link findChildren}'s `triagedAt: null` read-exclusion
   * invariant. Workspace-scoped (finding-#26). Read-only path → `db` singleton;
   * empty parent set short-circuits to `[]`.
   */
  async findChildrenCreatedAfter(
    parentIds: string[],
    workspaceId: string,
    after: Date,
  ): Promise<WorkItem[]> {
    if (parentIds.length === 0) return [];
    return db.workItem.findMany({
      where: {
        parentId: { in: parentIds },
        workspaceId,
        archivedAt: null,
        triagedAt: null,
        createdAt: { gt: after },
      },
    });
  },

  /**
   * Minimal STUBS for the roadmap's off-level blockers (Subtask 7.20.2 /
   * MOTIR-1331) — an `is_blocked_by` blocker that lives on ANOTHER level has no
   * node on screen, so the canvas anchors a red edge to a chip that NAMES it: its
   * `identifier` + `title` + the title of the container it lives in (its parent
   * story/epic). ONE query with the parent relation; empty input → `[]`.
   */
  async findRoadmapBlockerStubs(
    ids: string[],
  ): Promise<Array<{ id: string; identifier: string; title: string; parentTitle: string | null }>> {
    if (ids.length === 0) return [];
    const rows = await db.workItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, identifier: true, title: true, parent: { select: { title: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      parentTitle: r.parent?.title ?? null,
    }));
  },

  /**
   * Every work item currently recorded on a given session branch within a
   * workspace (Subtask 7.8.11) — the read backing `complete_session`'s bulk
   * close-out. Workspace-scoped (the explicit finding-#26 tenant gate, since RLS
   * is inert under the dev/CI superuser) and ordered by `key` so the bulk flip +
   * its per-item result list are deterministic. Rides the
   * `work_item_sessionBranch` index. Read-only path → `db` singleton.
   */
  async findBySessionBranch(sessionBranch: string, workspaceId: string): Promise<WorkItem[]> {
    return db.workItem.findMany({
      where: { sessionBranch, workspaceId },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * The CANDIDATE ready set of a project (Subtask 7.0.2): non-archived work
   * items whose OWN status is in the `todo` category (not-yet-started —
   * `workflow_status.category = 'todo'`; a "ready" item is one to START, so
   * `in_progress` and `done` are both excluded),
   * narrowed by the optional kind / assignee / priority facets and the cursor
   * seek-after, sorted `(type ASC, priority DESC, key ASC)` and capped at `limit`. ONE
   * `$queryRaw` returning the full `work_item` row (`w.*`) PLUS the joined status
   * `category` + assignee name/email/avatar — so the service feeds the 7.0.3
   * mapper (`WorkItem` + resolved context) without any extra read (no N+1).
   *
   * Readiness (the per-blocker terminal check) is NOT applied here — it's a
   * per-blocker-project property the service composes via `getReadinessForItems`
   * over this candidate set (finding #21). So this returns CANDIDATES; the
   * service filters to ready ones, which may shorten a page.
   *
   * **Sort + cursor (Subtask 7.0.12, reversing 7.0.11's precedence).**
   * `(type ASC, priority DESC, key ASC)`: **type is primary** via a CASE rank
   * built from `READY_KIND_RANK` (`subtask` first … `epic` last — the leaf-most
   * dispatchable unit before a container); **priority breaks the type tie** —
   * the `priority` enum sorts by its declaration order (`lowest < … < highest`)
   * so `DESC` puts `highest` first within a type bucket; `key ASC` breaks the
   * final tie (stable, monotonic, reseed-safe). The cursor is the (kind,
   * priority, key) of the previous page's last candidate; the 3-tuple seek-after
   * predicate (`kindRank > ckr OR (kindRank = ckr AND priority < cp) OR
   * (kindRank = ckr AND priority = cp AND key > ck)`) resumes strictly after it.
   * `priority` is cast text→enum so the bound param compares against the column;
   * the same `READY_KIND_RANK`-derived CASE feeds the ORDER BY and the seek-after
   * so they can never disagree.
   *
   * **Todo-only via INNER JOIN.** The `JOIN workflow_status` (not LEFT) plus
   * `ws.category = 'todo'` is the not-yet-started filter AND the category source
   * in one move: a ready item is one to START, so `in_progress` and `done` are
   * both excluded, and an item whose `status` references no live workflow row
   * can't be ready either, so dropping it is correct. Explicit `projectId` +
   * `workspaceId` gate (finding #26 — RLS is inert under the dev/CI superuser).
   * Read-only path → `db` singleton.
   *
   * **Leaf-only — a container is not dispatchable (Subtask 7.0.10).** A work item
   * that has been broken down into children is a planning CONTAINER, not a unit
   * of work: you dispatch its children, never the container itself. So any item
   * with ≥1 live (non-archived) child is excluded via
   * `NOT EXISTS (… c."parentId" = w."id" …)`. This is the GENERAL reading of the
   * reported bug (not epic/story-only): the ready set is the dispatchable LEAVES
   * of the execution tree — the AI-native intent (decision-ladder rung 1; the
   * deeper kind-parent matrix that lets a task/bug parent children is finding #41,
   * so a childed task/bug is a container too). A `subtask` (the matrix's only leaf)
   * can never have children, so it is unaffected. Archived children don't count
   * (they're soft-deleted, mirroring the `w."archivedAt" IS NULL` row filter), so
   * a parent whose children were all archived becomes dispatchable again. Kept
   * inside the single query (no N+1) → `listReady` / `getNextReady` / `countReady`
   * all agree automatically.
   */
  async findReadyCandidates(
    projectId: string,
    workspaceId: string,
    filter: {
      kinds?: WorkItemKind[];
      assigneeId?: string | null;
      priority?: WorkItemPriority[];
      cursor?: ReadyCursor;
      limit: number;
    },
  ): Promise<ReadyCandidateRow[]> {
    // The issue-type rank used by both the ORDER BY tiebreaker and the cursor
    // seek-after below. Built from READY_KIND_RANK (the single source of the
    // dispatch order, `subtask` first … `epic` last) so the two never drift.
    const kindRankSql = Prisma.sql`CASE w."kind"::text ${Prisma.join(
      Object.entries(READY_KIND_RANK).map(([k, rank]) => Prisma.sql`WHEN ${k} THEN ${rank}`),
      ' ',
    )} ELSE ${Object.keys(READY_KIND_RANK).length} END`;

    const preds: Prisma.Sql[] = [];
    if (filter.kinds && filter.kinds.length > 0) {
      const kinds = filter.kinds.map((k) => k as string);
      preds.push(Prisma.sql`w."kind"::text = ANY(${kinds})`);
    }
    if (filter.priority && filter.priority.length > 0) {
      const prios = filter.priority.map((p) => p as string);
      preds.push(Prisma.sql`w."priority"::text = ANY(${prios})`);
    }
    if (filter.assigneeId === null) {
      preds.push(Prisma.sql`w."assigneeId" IS NULL`);
    } else if (filter.assigneeId !== undefined) {
      preds.push(Prisma.sql`w."assigneeId" = ${filter.assigneeId}`);
    }
    if (filter.cursor) {
      const cp = filter.cursor.priority;
      const ckr = READY_KIND_RANK[filter.cursor.kind];
      const ck = filter.cursor.key;
      // Seek-after under `(kindRank ASC, priority DESC, key ASC)`: strictly
      // after the previous page's last candidate.
      preds.push(
        Prisma.sql`(
          ${kindRankSql} > ${ckr}
          OR (${kindRankSql} = ${ckr} AND w."priority" < ${cp}::"work_item_priority")
          OR (${kindRankSql} = ${ckr} AND w."priority" = ${cp}::"work_item_priority" AND w."key" > ${ck})
        )`,
      );
    }
    const where = preds.length ? Prisma.join(preds, ' AND ') : Prisma.sql`TRUE`;

    return db.$queryRaw<ReadyCandidateRow[]>`
      SELECT w.*,
             ws."category"::text AS "statusCategory",
             au."name"           AS "assigneeName",
             au."email"          AS "assigneeEmail",
             au."image"          AS "assigneeImage"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ws."category" = 'todo'
          AND NOT EXISTS (
            SELECT 1 FROM "work_item" c
             WHERE c."parentId" = w."id"
               AND c."archivedAt" IS NULL
          )
          AND (${where})
        ORDER BY ${kindRankSql} ASC, w."priority" DESC, w."key" ASC
        LIMIT ${filter.limit}`;
  },

  /**
   * One LAYER of the top-down ready traversal (Subtask 7.0.13): the project's
   * non-archived, non-triage work items at a single parent level — the ROOTS
   * (`parentIds === null` → `parentId IS NULL`) or the direct children of a set
   * of parents (`parentId = ANY(parentIds)`). Each row carries its live status
   * `category` and a `hasChildren` flag, so the service can decide per row:
   * DESCEND into a ready container (`hasChildren`), or COLLECT a ready childless
   * `todo` leaf into the dispatch set.
   *
   * This is the read that replaces the whole-table `findReadyCandidates` scan in
   * the ready LIST path: the traversal only ever fetches the children of nodes
   * already known to be ready, so a not-ready or fully-planned-out branch is
   * never read. No status/leaf pre-filter here (the service applies the
   * cascade + leaf rule); only the structural + tenant + archive/triage gates.
   * `workspaceId` is filtered explicitly (finding #26 — RLS inert under the
   * dev/CI superuser). Read-only → `db` singleton. Empty `parentIds` short-
   * circuits to `[]` (no degenerate `= ANY('{}')`).
   */
  async findReadyLayer(
    projectId: string,
    workspaceId: string,
    parentIds: string[] | null,
  ): Promise<ReadyLayerRow[]> {
    if (parentIds !== null && parentIds.length === 0) return [];
    const parentPred =
      parentIds === null
        ? Prisma.sql`w."parentId" IS NULL`
        : Prisma.sql`w."parentId" = ANY(${parentIds})`;
    return db.$queryRaw<ReadyLayerRow[]>`
      SELECT w.*,
             ws."category"::text AS "statusCategory",
             au."name"           AS "assigneeName",
             au."email"          AS "assigneeEmail",
             au."image"          AS "assigneeImage",
             EXISTS (
               SELECT 1 FROM "work_item" c
                WHERE c."parentId" = w."id"
                  AND c."archivedAt" IS NULL
             )                   AS "hasChildren"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${parentPred}`;
  },

  /**
   * The ATOMIC claim read for `claim_next_ready` (MOTIR-1330) — the dispatch
   * race-fix. Given the service's pre-computed ready candidate ids in
   * dispatch-rank order, LOCK the highest-ranked one that is still claimable and
   * return its id, under the caller's transaction. `FOR UPDATE … SKIP LOCKED` is
   * what makes two concurrent claimers take DIFFERENT items: the loser SKIPS the
   * row another transaction already holds (rather than blocking on it), and
   * `array_position` keeps the service's rank so each caller still takes the best
   * row still available to it. A row is claimable iff it is NOT archived and its
   * status is still in the `todo` category — a sibling that already claimed it
   * flipped it to `in_progress` (category `in_progress`), dropping it out.
   * Returns `null` when every candidate is locked or no longer `todo`; the caller
   * treats that as "retry / nothing claimable". `tx` REQUIRED — this read GUARDS
   * the immediately-following status write.
   */
  async claimNextReadyCandidate(
    orderedIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    if (orderedIds.length === 0) return null;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT w."id"
        FROM "work_item" w
        JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."id" = ANY(${orderedIds}::text[])
         AND w."archivedAt" IS NULL
         AND ws."category" = 'todo'
       ORDER BY array_position(${orderedIds}::text[], w."id")
       FOR UPDATE OF w SKIP LOCKED
       LIMIT 1`;
    return rows[0] ?? null;
  },

  /**
   * The triage QUEUE read (Subtask 6.11.3, per docs/decisions/triage-model.md
   * §2) — the ONE read that INVERTS the `notInTriageSql` exclusion: it returns
   * ONLY triage-marked items for a project, never the planned tree. The ACTIVE
   * queue an admin works through:
   *
   *   • `triagedAt IS NOT NULL`        — only triage items
   *   • `ws."category" <> 'done'`      — hides DECLINED / MERGED items (decline
   *                                      and merge cancel the item to a terminal
   *                                      `category = 'done'` status while KEEPING
   *                                      the triage marker, ADR §5; they leave the
   *                                      active queue but never re-enter the tree)
   *   • snooze window                  — hides currently-snoozed items
   *                                      (`snoozedUntil > now()`); a NULL or past
   *                                      `snoozedUntil` is active
   *
   * Ordered newest-first (`triagedAt DESC`) with an `id ASC` tiebreak so the
   * `(triagedAt, id)` seek-after cursor is a total order (no skip/repeat across
   * pages). Cursor-paginated — `take + 1` lets the service derive the next
   * cursor without a COUNT (finding #57 — the public form can flood the inbox;
   * NEVER load-all). Resolves the status `category` (so the service needn't
   * re-query) + the SUBMITTER display fields and workspace-membership flag for
   * attribution in the SAME read. Read-only path → `db` singleton (optional
   * `tx`). The explicit `workspaceId` + `projectId` gate is the app-layer
   * tenancy check (finding #26).
   */
  async findTriageQueue(
    projectId: string,
    workspaceId: string,
    options: { limit: number; cursor?: TriageQueueCursor },
    tx?: Prisma.TransactionClient,
  ): Promise<TriageQueueRow[]> {
    const client = tx ?? db;
    // The snooze cutoff is a BOUND `Date` param, not SQL `NOW()`: Prisma stores
    // `DateTime` as a naive-UTC `timestamp` (no tz), so a `timestamp <= now()
    // [timestamptz]` comparison reinterprets the column through the session
    // timezone and skews by the offset. Binding a `Date` compares like-for-like
    // (the same pattern `aggregateCreatedByBucket` uses for its window bounds).
    const now = new Date();
    // The public-vote tally per request (Story 6.12 · Subtask 6.12.6) — the
    // demand signal the queue sorts by, highest-first. `COALESCE(...,0)` so an
    // item with no votes counts as 0 (the common case) and a zero-vote queue
    // keeps its newest-first order. The `vt` aggregate is GROUPed once and
    // LEFT-JOINed, so it stays O(votes) — never a correlated per-row count.
    // (`public_request_vote` is FORCE-RLS keyed on `app.user_id`/`app.system_admin`;
    // like the work_item read this query already relies on, the vote tally here
    // rides the app-layer `projectId`/`workspaceId` gate + the app connection's
    // RLS-secondary posture — finding #26. When that table's RLS is enforced for
    // this read, the whole triage read moves to a system/workspace context.)
    const voteCountSql = Prisma.sql`COALESCE(vt."votes", 0)`;
    // Seek-after under `(voteCount DESC, triagedAt DESC, id ASC)`: strictly after
    // the previous page's last item. Bound params, never interpolated.
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            ${voteCountSql} < ${options.cursor.voteCount}
            OR (${voteCountSql} = ${options.cursor.voteCount} AND w."triagedAt" < ${options.cursor.triagedAt})
            OR (${voteCountSql} = ${options.cursor.voteCount} AND w."triagedAt" = ${options.cursor.triagedAt} AND w."id" > ${options.cursor.id})
          )`
      : Prisma.empty;
    return client.$queryRaw<TriageQueueRow[]>`
      SELECT w.*,
             ws."category"::text   AS "statusCategory",
             su."name"             AS "submitterName",
             su."email"            AS "submitterEmail",
             su."image"            AS "submitterImage",
             (sm."userId" IS NOT NULL) AS "submitterIsMember",
             ${voteCountSql}::int  AS "voteCount"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN "user" su ON su."id" = w."submittedByUserId"
        LEFT JOIN "workspace_membership" sm
              ON sm."userId" = w."submittedByUserId" AND sm."workspaceId" = w."workspaceId"
        LEFT JOIN (
               SELECT "work_item_id", COUNT(*) AS "votes"
                 FROM "public_request_vote"
                GROUP BY "work_item_id"
             ) vt ON vt."work_item_id" = w."id"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NOT NULL
          AND ws."category" <> 'done'
          AND (w."snoozedUntil" IS NULL OR w."snoozedUntil" <= ${now})
          ${cursorPred}
        ORDER BY ${voteCountSql} DESC, w."triagedAt" DESC, w."id" ASC
        LIMIT ${options.limit}`;
  },

  /**
   * The PUBLIC ROADMAP "Submitted" column read (Story 6.12 · Subtask 6.12.7) —
   * the still-in-triage public requests (the demand-gathering bucket). It
   * mirrors the active `findTriageQueue` predicate (a triage-marked, non-
   * declined, non-snoozed item) but ADDS `submittedByUserId IS NOT NULL` so only
   * real public submissions surface on the internet-facing roadmap (a never-
   * attributed legacy triage row is never exposed) and returns the PUBLIC
   * projection bits only (no reporter PII — the public mapper drops everything
   * but the public-safe fields). Ordered `(voteCount DESC, triagedAt DESC, id
   * ASC)` — highest-demand first — and cursor-paginated (`take + 1` in the
   * service; the at-scale rule, never load-all). `voterUserId` (nullable — a
   * logged-out reader) drives the per-card `voted` probe. Read-only → `db`
   * singleton; the vote aggregate rides the app-layer `projectId`/`workspaceId`
   * gate + RLS-secondary posture (finding #26), like `findTriageQueue`.
   */
  async findPublicRoadmapSubmitted(
    projectId: string,
    workspaceId: string,
    options: { limit: number; cursor?: PublicRoadmapCursor; voterUserId: string | null },
  ): Promise<PublicRoadmapRow[]> {
    // Bind `now` as a JS Date param (never SQL NOW()) — the timestamp-vs-
    // timestamptz skew guard `findTriageQueue` documents.
    const now = new Date();
    const votes = Prisma.sql`COALESCE(vt."votes", 0)`;
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            ${votes} < ${options.cursor.voteCount}
            OR (${votes} = ${options.cursor.voteCount} AND w."triagedAt" < ${options.cursor.recency})
            OR (${votes} = ${options.cursor.voteCount} AND w."triagedAt" = ${options.cursor.recency} AND w."id" > ${options.cursor.id})
          )`
      : Prisma.empty;
    return db.$queryRaw<PublicRoadmapRow[]>`
      SELECT w.*,
             ${votes}::int                  AS "voteCount",
             (mv."work_item_id" IS NOT NULL) AS "voted"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN (
               SELECT "work_item_id", COUNT(*) AS "votes"
                 FROM "public_request_vote"
                GROUP BY "work_item_id"
             ) vt ON vt."work_item_id" = w."id"
        LEFT JOIN "public_request_vote" mv
              ON mv."work_item_id" = w."id" AND mv."user_id" = ${options.voterUserId}
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NOT NULL
          AND w."submittedByUserId" IS NOT NULL
          AND ws."category" <> 'done'
          AND (w."snoozedUntil" IS NULL OR w."snoozedUntil" <= ${now})
          ${cursorPred}
        ORDER BY ${votes} DESC, w."triagedAt" DESC, w."id" ASC
        LIMIT ${options.limit}`;
  },

  /**
   * The total of the roadmap "Submitted" column (Subtask 6.12.7) — the same
   * active-public-request predicate as {@link findPublicRoadmapSubmitted}, minus
   * the cursor/limit, so the column header shows a real count (never the loaded-
   * page length). One bounded aggregate. Read-only → `db` singleton.
   */
  async countPublicRoadmapSubmitted(projectId: string, workspaceId: string): Promise<number> {
    const now = new Date();
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NOT NULL
          AND w."submittedByUserId" IS NOT NULL
          AND ws."category" <> 'done'
          AND (w."snoozedUntil" IS NULL OR w."snoozedUntil" <= ${now})`;
    return rows[0]?.count ?? 0;
  },

  /**
   * A PUBLIC ROADMAP "promoted" column read (Subtask 6.12.7) — the graduated
   * (non-triage) public-facing items whose workflow `status` is one of
   * `statusKeys` (the service maps the project's real statuses to the Planned /
   * In&nbsp;progress / Done buckets; Done's keys deliberately EXCLUDE `cancelled`
   * so a "won't do" item never appears on the public roadmap). Same public
   * projection + vote aggregate + `voted` probe as the Submitted read, but
   * tiebroken on the monotonic per-project `key` (recency) rather than
   * `triagedAt`. Ordered `(voteCount DESC, key DESC, id ASC)`; cursor-paginated.
   * Empty `statusKeys` short-circuits to `[]` (a bucket that maps no live status
   * has no cards). Read-only → `db` singleton.
   */
  async findPublicRoadmapByStatus(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    options: {
      limit: number;
      cursor?: PublicRoadmapCursor;
      voterUserId: string | null;
      // Epic-privacy public exclusion (Subtask 6.14.4) — drop a private epic's
      // descendants for a non-member viewer (resolved by
      // `findPublicHiddenDescendantIds`). Absent/empty ⇒ no clause.
      excludeIds?: readonly string[];
    },
  ): Promise<PublicRoadmapRow[]> {
    if (statusKeys.length === 0) return [];
    const votes = Prisma.sql`COALESCE(vt."votes", 0)`;
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            ${votes} < ${options.cursor.voteCount}
            OR (${votes} = ${options.cursor.voteCount} AND w."key" < ${options.cursor.recency})
            OR (${votes} = ${options.cursor.voteCount} AND w."key" = ${options.cursor.recency} AND w."id" > ${options.cursor.id})
          )`
      : Prisma.empty;
    return db.$queryRaw<PublicRoadmapRow[]>`
      SELECT w.*,
             ${votes}::int                  AS "voteCount",
             (mv."work_item_id" IS NOT NULL) AS "voted"
        FROM "work_item" w
        LEFT JOIN (
               SELECT "work_item_id", COUNT(*) AS "votes"
                 FROM "public_request_vote"
                GROUP BY "work_item_id"
             ) vt ON vt."work_item_id" = w."id"
        LEFT JOIN "public_request_vote" mv
              ON mv."work_item_id" = w."id" AND mv."user_id" = ${options.voterUserId}
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', options.excludeIds)}
          AND w."status" = ANY(${statusKeys})
          ${cursorPred}
        ORDER BY ${votes} DESC, w."key" DESC, w."id" ASC
        LIMIT ${options.limit}`;
  },

  /**
   * Reusable server-side quick-search read (Subtask 6.9.1) — the single read
   * both link pickers (6.9.2) and, later, the cmd-K palette consume. Returns
   * non-archived work items in the WORKSPACE, restricted to `projectIds` (the
   * actor's BROWSABLE project set, resolved by the service's Story 6.4 gate —
   * pass the full set; the service short-circuits an empty set, so this is only
   * ever reached with ≥1 id), whose `identifier` matches the query (exact /
   * prefix, case-insensitive) OR whose `title` ILIKE-CONTAINS it. The title
   * contains-scan rides the 6.1.1 `pg_trgm` GIN index — it must not table-scan
   * 10k titles. Relevance-ordered — exact-identifier → identifier-prefix →
   * title-only match — then `key` ASC + `identifier` ASC as a stable, fully
   * deterministic tiebreak. Bounded to `limit` (finding #57 — never an
   * unbounded fetch). `excludeIds` drops specific rows (6.9.2's link picker
   * passes self + already-linked-for-the-relationship); omitted ⇒ no exclusion.
   * Explicit `workspaceId` gate — the primary tenant filter (finding #26; RLS
   * is inert under the dev/CI superuser). Read-only → `db` singleton. The query
   * binds as a parameter (never interpolated) and is pattern-escaped for LIKE
   * metacharacters, so a search for "50%" matches the literal "50%".
   */
  async quickSearch(
    workspaceId: string,
    projectIds: string[],
    query: string,
    limit: number,
    excludeIds: string[] = [],
  ): Promise<WorkItem[]> {
    if (projectIds.length === 0) return [];
    const exact = query.toLowerCase();
    const idPrefixPattern = `${escapeLikePattern(query)}%`;
    // Title match is Jira-style summary tokenisation: split the query on
    // whitespace and require the title to contain EVERY token (order-
    // independent), each a case-insensitive substring — so "board drag" finds
    // "Drag-and-drop on the board" even though the words aren't adjacent. A
    // single-token query collapses to one contains-match. Each token's ILIKE
    // rides the 6.1.1 `pg_trgm` GIN index. The identifier (key) match keeps the
    // WHOLE query (keys don't tokenise — "PROD-12" is one token).
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    const titleMatch = tokens.length
      ? Prisma.join(
          tokens.map((t) => Prisma.sql`w."title" ILIKE ${`%${escapeLikePattern(t)}%`}`),
          ' AND ',
        )
      : Prisma.sql`FALSE`;
    // Empty array params break `ANY`/`ALL` type inference; projectIds is
    // guaranteed non-empty above, and the exclusion is omitted entirely when
    // there's nothing to exclude.
    const excludeSql = excludeIds.length
      ? Prisma.sql`AND w."id" <> ALL(${excludeIds})`
      : Prisma.empty;
    return db.$queryRaw<WorkItem[]>`
      SELECT w.*
        FROM "work_item" w
        WHERE w."workspaceId" = ${workspaceId}
          AND w."projectId" = ANY(${projectIds})
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          ${excludeSql}
          AND (
            w."identifier" ILIKE ${idPrefixPattern}
            OR (${titleMatch})
          )
        ORDER BY
          CASE
            WHEN LOWER(w."identifier") = ${exact} THEN 0
            WHEN w."identifier" ILIKE ${idPrefixPattern} THEN 1
            ELSE 2
          END ASC,
          w."key" ASC,
          w."identifier" ASC
        LIMIT ${limit}`;
  },

  /**
   * Duplicate-detection match for a public submission (Story 6.12 · Subtask
   * 6.12.5) — the deterministic title search behind "upvote this instead"
   * (Canny's behaviour). Returns the project's ACTIVE public requests (kind
   * `bug` / `task`, not archived, NOT in a `done`-category status — so cancelled
   * / declined / shipped items are excluded) whose `title` contains EVERY query
   * token (the same Jira-style tokenisation `quickSearch` uses, riding the
   * 6.1.1 `pg_trgm` GIN index), newest-demand first (vote count DESC, then key).
   *
   * Two deliberate differences from `quickSearch`: it is scoped to ONE project
   * (the public project — a cross-org caller has no browsable-set) and it does
   * NOT apply the triage exclusion, so a still-in-triage request IS surfaceable
   * (a duplicate of an un-promoted submission must be join-able — the ADR §6
   * "DOES include still-in-triage requests"). The vote count rides the 6.12.3
   * `PublicRequestVote` join. A blank / token-less query returns []. Read-only →
   * the `db` singleton; `query` binds as a param (never interpolated) and is
   * pattern-escaped for LIKE metacharacters.
   */
  async findPublicRequestMatches(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<PublicRequestMatchRow[]> {
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const titleMatch = Prisma.join(
      tokens.map((t) => Prisma.sql`w."title" ILIKE ${`%${escapeLikePattern(t)}%`}`),
      ' AND ',
    );
    return db.$queryRaw<PublicRequestMatchRow[]>`
      SELECT w.*, COALESCE(v."cnt", 0) AS "voteCount"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN (
          SELECT "work_item_id", COUNT(*)::int AS "cnt"
            FROM "public_request_vote"
            GROUP BY "work_item_id"
        ) v ON v."work_item_id" = w."id"
        WHERE w."projectId" = ${projectId}
          AND w."kind"::text IN ('bug', 'task')
          AND w."archivedAt" IS NULL
          AND ws."category" <> 'done'
          AND (${titleMatch})
        ORDER BY "voteCount" DESC, w."key" ASC
        LIMIT ${limit}`;
  },

  /**
   * Non-archived siblings under a parent WITHIN a project, ordered by
   * fractional `position` (Subtask 1.4.4). Distinct from `findChildren`: a
   * top-level sibling set has `parentId IS NULL`, and scoping by `projectId`
   * keeps a null-parent query from spanning every project's roots. Used by
   * `createWorkItem` to find the last sibling whose position the new item
   * appends after. Read-inside-a-transaction (the create flow allocates +
   * inserts atomically) → takes the same optional `tx` as the other reads.
   */
  async findSiblings(
    projectId: string,
    parentId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    return client.workItem.findMany({
      where: { projectId, parentId, archivedAt: null },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * Non-archived work items in a project, filtered by any combination of
   * kind / status / assignee (Subtask 1.4.4). Ordered by `key` asc to match
   * the PROD-N identifier order the list surfaces render. A read-only list
   * path → `db` singleton. Each filter is applied only when supplied, so the
   * no-filter call returns every non-archived row in the project.
   */
  async findByProjectFiltered(
    projectId: string,
    filter: { kind?: WorkItemKind; status?: string; assigneeId?: string | null } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    return client.workItem.findMany({
      where: {
        projectId,
        archivedAt: null,
        triagedAt: null, // read-exclusion (Subtask 6.11.3)
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.assigneeId !== undefined ? { assigneeId: filter.assigneeId } : {}),
      },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * Non-archived work items in a project whose `kind` is one of `kinds`,
   * ordered by `key` asc (the stable PROD-N identifier order). Carries an
   * EXPLICIT `workspaceId` filter (finding #26) — the primary tenant gate,
   * since RLS is inert under the dev/CI superuser. Backs
   * `workItemsService.listCandidateParents` (Subtask 2.3.4): the parent
   * picker's candidate set. Short-circuits to `[]` on an empty `kinds` list
   * (an `epic` child has no legal parents) so no pointless query is issued.
   */
  async findByProjectAndKinds(
    projectId: string,
    kinds: readonly WorkItemKind[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (kinds.length === 0) return [];
    const client = tx ?? db;
    return client.workItem.findMany({
      // triagedAt: null — a triage item is never a candidate parent (read-exclusion, 6.11.3).
      where: {
        projectId,
        workspaceId,
        kind: { in: [...kinds] },
        archivedAt: null,
        triagedAt: null,
      },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * Non-archived work items in a project, cursor-paginated. Ordered by `key`
   * asc (stable, monotonic, matches the PROD-N identifier order). `cursor` is
   * a work-item id; when present the row at the cursor is skipped so paging
   * doesn't repeat it.
   */
  async findByProject(
    projectId: string,
    options: { take?: number; cursor?: string; excludeIds?: readonly string[] } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take = 50, cursor, excludeIds } = options;
    return client.workItem.findMany({
      where: {
        projectId,
        archivedAt: null,
        triagedAt: null, // read-exclusion (6.11.3)
        // Epic-privacy public exclusion (6.14.4): drop descendants of a private
        // epic for a non-member viewer. Absent/empty ⇒ no clause (members + the
        // no-private-epic case read the unchanged projection).
        ...(excludeIds && excludeIds.length > 0 ? { id: { notIn: excludeIds as string[] } } : {}),
      },
      orderBy: { key: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * EVERY non-archived, non-triage work item of a project, with the lean columns
   * the pre-commit plan-validation projection needs (Subtask 7.28.1 / MOTIR-1386):
   * id + identifier + status + parentId + sprintId + projectId. ONE round-trip,
   * unpaginated — `planValidityService` builds an in-memory virtual graph of the
   * whole project (live tree ⊕ a Plan's PlanItem delta) and runs the shipped
   * finishability rules over it, so it needs the project's full node set, not a
   * page. `workspaceId`-gated (finding #26; RLS is inert under the dev/CI
   * superuser) and `archivedAt`/`triagedAt`-excluded (the same read-exclusion the
   * validity engines use, so a soft-removed/triage row never phantom-projects).
   * Read-only path → `db` singleton.
   */
  async findAllByProjectForValidity(
    projectId: string,
    workspaceId: string,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      status: string;
      parentId: string | null;
      sprintId: string | null;
      projectId: string;
    }>
  > {
    return db.workItem.findMany({
      where: { projectId, workspaceId, archivedAt: null, triagedAt: null },
      select: {
        id: true,
        identifier: true,
        status: true,
        parentId: true,
        sprintId: true,
        projectId: true,
      },
    });
  },

  /**
   * The ids of every work item that DESCENDS from a PRIVATE epic
   * (`kind = 'epic' AND publicChildrenHidden = true`) in this project — the set a
   * public / non-member read must EXCLUDE (Story 6.14 · Subtask 6.14.4, per
   * `docs/decisions/epic-privacy.md` §6). Seeded from the (tiny, index-backed —
   * `@@index([projectId, publicChildrenHidden])`) private-epic set and walked
   * DOWN the `parentId` edge in ONE recursive CTE, so it is depth-agnostic (the
   * tree caps at 4: epic → story → task → subtask) and resolved entirely in SQL —
   * never a load-all-then-filter-in-app (finding #57). The private epic ROWS
   * themselves are NOT included (they stay visible as the "this epic is not
   * public" placeholder); only their descendants are returned. Returns `[]` when
   * the project has no private epic (the common case — the caller then skips the
   * exclusion entirely). The `workspaceId` gate rides every step (the app-layer
   * tenancy check atop RLS, finding #26). Read-only → `db` singleton.
   *
   * NOTE on scale: the descendant set is bounded by the private subtrees' size
   * and is consumed as an indexable `id <> ALL(...)` array predicate. A
   * denormalized root-epic column would collapse this to a single equality but
   * costs write-time fan-out + a backfill; the ADR (§6) deliberately DEFERS it —
   * the bounded depth + tiny private-epic set make the CTE the simpler correct
   * shape, and adding the column later does not change this method's contract.
   */
  async findPublicHiddenDescendantIds(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? db;
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE hidden AS (
        SELECT c."id", c."parentId"
          FROM "work_item" c
          JOIN "work_item" e ON e."id" = c."parentId"
          WHERE c."workspaceId" = ${workspaceId}
            AND e."projectId" = ${projectId}
            AND e."workspaceId" = ${workspaceId}
            AND e."kind"::text = 'epic'
            AND e."publicChildrenHidden" = true
        UNION ALL
        SELECT c."id", c."parentId"
          FROM "work_item" c
          JOIN hidden h ON h."id" = c."parentId"
          WHERE c."workspaceId" = ${workspaceId}
      )
      SELECT "id" FROM hidden`;
    return rows.map((r) => r.id);
  },

  /**
   * The most recent work-item activity per project, for a SET of projects, in
   * ONE grouped aggregate — the "recent activity" stat for a page of PROJECT
   * SQUARE cards (Story 6.13 · Subtask 6.13.2), avoiding a per-card N+1. Returns
   * one `{ projectId, lastActivityAt }` per project that has at least one
   * non-archived, non-triage work item (a project with none is simply absent —
   * the service defaults its activity to null). Excludes archived + triage items
   * so the signal reflects the publicly-visible planned tree (the 6.11.3
   * read-exclusion + the 6.12.4 public projection), not internal triage churn.
   * Empty input short-circuits to `[]` (no pointless query). Read-only cross-org
   * path → `db` singleton + the app-layer `projectId` filter (the directory's
   * public-only set is enforced one layer up).
   */
  async maxActivityByProjects(
    projectIds: string[],
  ): Promise<Array<{ projectId: string; lastActivityAt: Date | null }>> {
    if (projectIds.length === 0) return [];
    const rows = await db.workItem.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, archivedAt: null, triagedAt: null },
      _max: { updatedAt: true },
    });
    return rows.map((r) => ({ projectId: r.projectId, lastActivityAt: r._max.updatedAt }));
  },

  /**
   * How many work items in a project reference a given status key (Subtask
   * 2.2.5's delete-protection: a status still in use can't be removed).
   * Counts ALL items including archived — an archived item's status string
   * still references the status, so deleting it would orphan that reference.
   */
  async countByProjectAndStatusKey(
    projectId: string,
    statusKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.workItem.count({ where: { projectId, status: statusKey } });
  },

  /**
   * Every work item in a project that references a given status key — INCLUDING
   * archived ones (Subtask 2.3.1's delete-with-reassign). The scope mirrors
   * `countByProjectAndStatusKey` exactly: an archived item's status string
   * still points at the status, so the reassign must migrate it too or deleting
   * the status would leave a dangling reference. Used inside the delete tx, so
   * it takes `tx`.
   */
  async findByProjectAndStatusKey(
    projectId: string,
    statusKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    return client.workItem.findMany({ where: { projectId, status: statusKey } });
  },

  /**
   * Direct (non-archived) children of a work item, ordered by fractional
   * `position`. One level only — for the full subtree use `findSubtree`.
   */
  async findChildren(parentId: string, tx?: Prisma.TransactionClient): Promise<WorkItem[]> {
    const client = tx ?? db;
    return client.workItem.findMany({
      // triagedAt: null is a no-op in practice (a triage item is always
      // parentless, so never a child) but documents + enforces the read-exclusion
      // invariant uniformly so no future child read can leak triage (6.11.3).
      where: { parentId, archivedAt: null, triagedAt: null },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * The full subtree rooted at `rootId`, in ONE round-trip via a recursive
   * CTE. Returns each row with its `depth` (root = 1), ordered depth-first by
   * position so the result reads as a pre-order tree walk. Identifiers are
   * double-quoted because the columns are camelCase; `kind` is cast to text so
   * `$queryRaw` returns the plain enum label.
   */
  async findSubtree(rootId: string, tx?: Prisma.TransactionClient): Promise<WorkItemSubtreeRow[]> {
    const client = tx ?? db;
    return client.$queryRaw<WorkItemSubtreeRow[]>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."position", 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ${rootId}
        UNION ALL
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."position", s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
      )
      SELECT "id",
             "parentId",
             "kind"::text       AS "kind",
             "key",
             "identifier",
             "title",
             "status",
             "position",
             depth::int AS "depth"
        FROM subtree
        ORDER BY depth ASC, "position" ASC`;
  },

  /**
   * The NON-archived members of a work item's subtree (the root + every live
   * descendant) — the "containing set" the `validate_work_item` finishability
   * check (Subtask 7.8.23) keys its "is this blocker IN the subtree?" test on.
   * A recursive CTE walking DOWN `parentId` from `rootId`, mirroring
   * {@link findSubtree} but trimmed to the validity columns (`id` for the
   * membership test, `identifier` to NAME a gated item, `status` for the
   * not-done filter) and, crucially, EXCLUDING archived/triage rows on BOTH the
   * anchor and the recursive step (a soft-removed item is not real work and must
   * never gate, mirroring the readiness reads). `workspaceId`-gated throughout
   * (finding #26). Parent↔child is same-project, so the caller judges done-ness
   * against the root's project terminal set. Read-only → `db` singleton.
   */
  async findSubtreeMembersForValidity(
    rootId: string,
    workspaceId: string,
  ): Promise<Array<{ id: string; identifier: string; status: string }>> {
    return db.$queryRaw<Array<{ id: string; identifier: string; status: string }>>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."identifier", w."status"
          FROM "work_item" w
          WHERE w."id" = ${rootId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
        UNION ALL
        SELECT w."id", w."parentId", w."identifier", w."status"
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
          WHERE w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
      )
      SELECT "id", "identifier", "status" FROM subtree`;
  },

  /**
   * Per-kind count of the LIVE (non-archived) DESCENDANTS of a subtree, in ONE
   * round-trip via a recursive CTE (Story 2.9 · Subtask 2.9.9). The root is
   * EXCLUDED (`depth > 1`) and only rows with `archivedAt IS NULL` are counted,
   * so this is the live slice of `findSubtree` the delete-preview reports
   * alongside the full cascade count: archiving is single-node, so an archived
   * parent can still own live descendants a cascade delete would destroy.
   * `kind` is cast to text (the plain enum label); `count` is cast to `int` so
   * `$queryRaw` returns a JS number rather than a Postgres `bigint`. Kinds with
   * zero live descendants simply do not appear (GROUP BY emits matched rows
   * only) — the service folds the rows into the DTO's `liveByKind` map.
   */
  async countLiveDescendantsByKind(
    rootId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ kind: WorkItemKind; count: number }>> {
    const client = tx ?? db;
    return client.$queryRaw<Array<{ kind: WorkItemKind; count: number }>>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."kind", w."archivedAt", 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ${rootId}
        UNION ALL
        SELECT w."id", w."parentId", w."kind", w."archivedAt", s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
      )
      SELECT "kind"::text AS "kind", COUNT(*)::int AS "count"
        FROM subtree
        WHERE depth > 1
          AND "archivedAt" IS NULL
        GROUP BY "kind"`;
  },

  /**
   * The roadmap PROGRESS roll-up (Subtask 7.20.6 / MOTIR-1013) for a set of
   * container roots, in ONE recursive-CTE round-trip. For each root in
   * `rootIds`, counts its LIVE (non-archived) DESCENDANTS (the root EXCLUDED,
   * `depth > 1`), attributing every descendant to its originating root carried
   * down the recursion:
   *  - `total` — descendants whose status is NOT the sealed `excludedStatusKey`
   *    (`cancelled`), so a container whose only remnants are cancelled isn't held
   *    permanently incomplete;
   *  - `done`  — descendants whose status is one of `doneStatusKeys` (the
   *    `done`-category keys except cancelled, which the service computes).
   * A root with no live descendants simply does not appear in the result (the
   * GROUP BY emits matched rows only) → the service treats it as `0 / 0`. Counts
   * are cast to `int` so `$queryRaw` returns JS numbers, not Postgres `bigint`.
   * Empty `rootIds` short-circuits to `[]` (never a degenerate `= ANY('{}')`).
   */
  async countRoadmapProgress(
    rootIds: string[],
    doneStatusKeys: string[],
    excludedStatusKey: string,
    sprintId: string | null = null,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ rootId: string; total: number; done: number }>> {
    if (rootIds.length === 0) return [];
    const client = tx ?? db;
    // Sprint scope (MOTIR-1381): a container's progress meter counts only its
    // IN-SPRINT descendants (sprint membership is the flat `sprintId`), so the
    // meter reflects the sprint's slice of the branch, not the whole subtree.
    // `null` ⇒ no restriction (the whole-project rollup, byte-for-byte unchanged).
    const sprintFilter = sprintId ? Prisma.sql`AND "sprintId" = ${sprintId}` : Prisma.empty;
    return client.$queryRaw<Array<{ rootId: string; total: number; done: number }>>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."status", w."archivedAt", w."sprintId", w."id" AS root_id, 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ANY(${rootIds})
        UNION ALL
        SELECT w."id", w."parentId", w."status", w."archivedAt", w."sprintId", s.root_id, s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
      )
      SELECT root_id AS "rootId",
             COUNT(*) FILTER (WHERE "status" <> ${excludedStatusKey})::int AS "total",
             COUNT(*) FILTER (WHERE "status" = ANY(${doneStatusKeys}))::int  AS "done"
        FROM subtree
        WHERE depth > 1
          AND "archivedAt" IS NULL
          ${sprintFilter}
        GROUP BY root_id`;
  },

  /**
   * The ANCESTOR chain of a work item — its parent, grandparent, … up to the
   * root — in ONE round-trip via a recursive CTE walking UP the `parentId`
   * edge (the inverse of `findSubtree`). Excludes the item itself; returns the
   * ancestors ordered ROOT→self (the immediate parent LAST), which is the order
   * the detail-page breadcrumb renders (Subtask 2.4.3). The walk is naturally
   * bounded — it stops at the root (`parentId IS NULL`) and the tree depth is
   * capped at 4 (Story 1.4) — so this is a short, fixed-length parent walk, not
   * an unbounded recursion.
   *
   * `workspaceId` is filtered on BOTH the anchor and the recursive step, so a
   * cross-workspace ancestor can never leak into the chain (the primary tenant
   * gate per finding #26 — RLS is inert under the dev/CI superuser). `w.*`
   * carries every WorkItem column so the service maps each ancestor with the
   * shared `toWorkItemSummaryDto`; the CTE-internal `depth` only orders the
   * result and is ignored by the caller.
   */
  async findAncestors(
    itemId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    return client.$queryRaw<WorkItem[]>`
      WITH RECURSIVE ancestors AS (
        SELECT w.*, 0 AS depth
          FROM "work_item" w
          WHERE w."id" = ${itemId} AND w."workspaceId" = ${workspaceId}
        UNION ALL
        SELECT p.*, a.depth + 1
          FROM "work_item" p
          JOIN ancestors a ON p."id" = a."parentId"
          WHERE p."workspaceId" = ${workspaceId}
      )
      SELECT * FROM ancestors WHERE depth > 0 ORDER BY depth DESC`;
  },

  /**
   * Batch ancestor walk (Subtask 7.0.13) — for EACH of `itemIds`, the ids of all
   * its ancestors (parent → grandparent → … → root). The readiness cascade gates
   * a node on its whole ancestor chain (a leaf is ready only if every ancestor is
   * ready too), and the batch readiness path must resolve those chains for many
   * items WITHOUT an N+1 — so this is the multi-seed analogue of `findAncestors`:
   * ONE recursive CTE seeded from the full id set, emitting a `(seedId,
   * ancestorId)` row per ancestor. An item with no parent contributes no row and
   * maps to `[]`. `workspaceId` is filtered on BOTH the anchor and the recursive
   * step so a cross-workspace ancestor can never enter a chain (the finding-#26
   * tenant gate, mirroring `findAncestors`). Depth is tree-capped at 4 (Story
   * 1.4), so the recursion is short and bounded. Read-only → `db` singleton.
   */
  async findAncestorIdsForItems(
    itemIds: string[],
    workspaceId: string,
  ): Promise<Map<string, string[]>> {
    const byItem = new Map<string, string[]>(itemIds.map((id) => [id, []]));
    if (itemIds.length === 0) return byItem;
    const rows = await db.$queryRaw<Array<{ seedId: string; ancestorId: string }>>`
      WITH RECURSIVE chain AS (
        SELECT w."id" AS "seedId", w."parentId" AS "ancestorId"
          FROM "work_item" w
          WHERE w."id" IN (${Prisma.join(itemIds)})
            AND w."workspaceId" = ${workspaceId}
            AND w."parentId" IS NOT NULL
        UNION ALL
        SELECT c."seedId", p."parentId" AS "ancestorId"
          FROM "work_item" p
          JOIN chain c ON p."id" = c."ancestorId"
          WHERE p."workspaceId" = ${workspaceId}
            AND p."parentId" IS NOT NULL
      )
      SELECT "seedId", "ancestorId" FROM chain`;
    for (const r of rows) {
      const arr = byItem.get(r.seedId);
      if (arr) arr.push(r.ancestorId);
    }
    return byItem;
  },

  /**
   * The DIRECT children of a set of parents, in ONE round-trip — the
   * parent→child completion dependency the sprint-finishability check walks
   * (`validate_sprint`). A parent can only be finished once ALL its children
   * are done, so each not-done in-sprint parent is gated by any child that is
   * neither done nor also in the sprint — exactly as an unsatisfied
   * `blocked_by` edge gates an item (mirrors {@link findBlockerEdgesForItems}).
   * Each row carries the child's IDENTITY (`childId` for the in-sprint
   * membership test, `childKey` to NAME it), its `childStatus`/`childProjectId`
   * (done-ness against the child's OWN project terminal set) and `childSprintId`
   * (in-sprint?). ARCHIVED and TRIAGE children are EXCLUDED (the same
   * read-exclusion as {@link findChildren}), so a soft-removed or triage item
   * never phantom-gates a sprint. `workspaceId`-gated (finding #26). Empty
   * `parentIds` short-circuits to `[]`. Read-only → `db` singleton.
   */
  async findChildrenForItems(
    parentIds: string[],
    workspaceId: string,
  ): Promise<
    Array<{
      parentId: string;
      childId: string;
      childKey: string;
      childStatus: string;
      childSprintId: string | null;
      childProjectId: string;
    }>
  > {
    if (parentIds.length === 0) return [];
    const rows = await db.workItem.findMany({
      where: {
        parentId: { in: parentIds },
        workspaceId,
        archivedAt: null,
        triagedAt: null,
      },
      select: {
        id: true,
        parentId: true,
        identifier: true,
        status: true,
        sprintId: true,
        projectId: true,
      },
    });
    return rows.map((r) => ({
      parentId: r.parentId as string,
      childId: r.id,
      childKey: r.identifier,
      childStatus: r.status,
      childSprintId: r.sprintId,
      childProjectId: r.projectId,
    }));
  },

  /**
   * The WHOLE non-archived issue forest of a project, in ONE round-trip via a
   * recursive CTE walking DOWN the `parentId` edge from the roots
   * (`parentId IS NULL`). Each row carries its `depth` (root = 1, for the
   * tree-table's indentation) and the lighter render columns (no Markdown
   * blobs). Backs `workItemsService.getProjectTree` (Subtask 2.5.1) — the read
   * behind the `/items` list view.
   *
   * `workspaceId` is filtered on BOTH the anchor and the recursive step (plus
   * `projectId` on both), so a cross-workspace/-project row can never enter the
   * forest even with RLS inert under the dev/CI superuser — the primary tenant
   * gate per finding #26 (mirrors `findAncestors` / `findByProjectAndKinds`).
   *
   * The optional `filter` is applied NON-destructively: it does NOT remove rows
   * (a flat `WHERE` would orphan children); instead every returned row carries a
   * `matched` boolean — true when it satisfies every supplied filter axis (an
   * empty filter marks all rows matched). The service nests the forest and, when
   * a filter is active, prunes to matched-or-has-matched-descendant so a match
   * keeps its ancestor chain for context. Each axis is a bound-param
   * `Prisma.Sql` fragment (never string-interpolated); `assigneeId: null`
   * filters to UNASSIGNED via `IS NOT DISTINCT FROM`; `text` is an escaped
   * case-insensitive `ILIKE` over identifier + title.
   */
  async findProjectForest(
    projectId: string,
    workspaceId: string,
    filter: RepoIssueFilter = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemForestRow[]> {
    const client = tx ?? db;
    // The facet axes, as a bound-param predicate over the forest alias `f`
    // (shared with the flat List read — see buildIssueFilterSql). The 6.1.1
    // AST axis is stripped here and compiled over a joined full `work_item`
    // row instead: the CTE's fixed projection lacks the columns the builder
    // can reference (`sprintId` / `createdAt` / `descriptionMd`), and
    // re-projecting Markdown blobs through the recursion would bloat it.
    const { ast, filterReferents, ...facetAxes } = filter;
    const facetMatched = buildIssueFilterSql(facetAxes, 'f');
    const hasAst = ast !== undefined && ast.conditions.length > 0;
    // COALESCE the combined expression: unlike a WHERE (where NULL means
    // unmatched for free), this is PROJECTED as the `matched` boolean column,
    // and AST arms over nullable columns (text contains, number comparisons)
    // can yield SQL NULL — which must surface as `false`, not a null DTO field.
    const matched = hasAst
      ? Prisma.sql`COALESCE((${facetMatched}) AND (${compileFilterConditionsSql(ast, filterReferents)}), FALSE)`
      : facetMatched;
    const astJoin = hasAst ? Prisma.sql`JOIN "work_item" w ON w."id" = f."id"` : Prisma.empty;

    return client.$queryRaw<WorkItemForestRow[]>`
      WITH RECURSIVE forest AS (
        SELECT w."id", w."parentId", w."kind", w."type", w."key", w."identifier",
               w."title", w."status", w."priority", w."assigneeId", w."reporterId",
               w."dueDate", w."estimateMinutes", w."storyPoints", w."updatedAt", 1 AS depth
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."parentId" IS NULL
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
        UNION ALL
        SELECT c."id", c."parentId", c."kind", c."type", c."key", c."identifier",
               c."title", c."status", c."priority", c."assigneeId", c."reporterId",
               c."dueDate", c."estimateMinutes", c."storyPoints", c."updatedAt", p.depth + 1
          FROM "work_item" c
          JOIN forest p ON c."parentId" = p."id"
          WHERE c."projectId" = ${projectId}
            AND c."workspaceId" = ${workspaceId}
            AND c."archivedAt" IS NULL
            AND ${notInTriageSql('c')}
      )
      SELECT f."id",
             f."parentId",
             f."kind"::text       AS "kind",
             f."type"::text       AS "type",
             f."key",
             f."identifier",
             f."title",
             f."status",
             f."priority"::text   AS "priority",
             f."assigneeId",
             f."reporterId",
             f."dueDate",
             f."estimateMinutes",
             f."storyPoints",
             f."updatedAt",
             f.depth::int         AS "depth",
             (${matched})         AS "matched"
        FROM forest f
        ${astJoin}
        ORDER BY f.depth ASC, f."key" ASC`;
  },

  /**
   * The flat, sorted project read powering the List view (Subtask 2.5.8). Unlike
   * `findProjectForest` this is NON-recursive — every non-archived item in the
   * project, un-nested, ordered by the active sort column at the DB layer (a
   * flat `ORDER BY`, never JS re-nesting/flattening). Same `projectId` +
   * `workspaceId` tenant gate on the single `work_item` scan (finding #26). The
   * same `filter` axes as the forest read apply (so the List honours the 2.5.4
   * filter bar when that lands), built via the shared `buildIssueFilterSql`.
   *
   * `assignee`/`reporter` sort by the joined user's display name; `status` by
   * the project workflow's status order (the `workflow_status.position`
   * fractional index — a lexicographically-sortable string); the rest are
   * `work_item` scalar columns (`priority` orders by its enum declaration
   * lowest→highest). The sort column is whitelisted through `ISSUE_SORT_SQL` —
   * never string-interpolated — and a stable `"key" ASC` tiebreak keeps paging
   * deterministic. Read-only path → `db` singleton (optional `tx`).
   */
  async findProjectIssuesFlat(
    projectId: string,
    workspaceId: string,
    sort: IssueSort,
    filter: RepoIssueFilter = {},
    page?: { limit: number; offset: number },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemListRow[]> {
    const client = tx ?? db;
    const matched = buildIssueFilterSql(filter, 'w');
    const orderCol = ISSUE_SORT_SQL[sort.column];
    const dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    // Server-side window (Subtask 2.5.12): the List is LIMIT/OFFSET-paged so it
    // never ships the whole backlog. The total-order ORDER BY (sort col + the
    // `key` ASC tiebreak) makes OFFSET paging stable — no row skips/repeats.
    const limitSql = page ? Prisma.sql`LIMIT ${page.limit} OFFSET ${page.offset}` : Prisma.empty;

    return client.$queryRaw<WorkItemListRow[]>`
      SELECT w."id",
             w."kind"::text       AS "kind",
             w."type"::text       AS "type",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."updatedAt"
        FROM "work_item" w
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        LEFT JOIN "user" ru ON ru."id" = w."reporterId"
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND (${matched})
        ORDER BY ${orderCol} ${dir} NULLS LAST, w."key" ASC
        ${limitSql}`;
  },

  /**
   * COUNT of a project's non-archived issues matching the SAME filter axes as
   * `findProjectIssuesFlat` (Subtask 2.5.12) — the denominator of the List's
   * "1–50 of N" pager, so it tracks the active 2.5.4 filter. A single
   * `COUNT(*)` over `work_item` (no joins — the filter predicate only touches
   * `work_item` columns), the same `projectId` + `workspaceId` tenant gate
   * (finding #26). `::int` casts Postgres' `bigint` count to a JS number (a
   * project's row count is far under 2^53). Read-only path → `db` singleton.
   */
  async countProjectIssues(
    projectId: string,
    workspaceId: string,
    filter: RepoIssueFilter = {},
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    const matched = buildIssueFilterSql(filter, 'w');
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', filter.excludeIds)}
          AND (${matched})`;
    return rows[0]?.count ?? 0;
  },

  /**
   * The ARCHIVED items of a project (Subtask 2.9.2) — the inverse of the
   * pervasive `archivedAt IS NULL` row filter: a single non-recursive scan of
   * the soft-deleted (`archivedAt IS NOT NULL`) items, un-nested (archive is
   * single-node — a parent's archive does NOT cascade, so archived items are a
   * FLAT set, never a forest; this deliberately does NOT reuse the recursive
   * `findProjectForest` CTE). Same `projectId` + `workspaceId` tenant gate as
   * the active reads (finding #26) and the same triage exclusion (the public
   * submission inbox has its own surface), so this is the literal complement of
   * the `/items` list within the management views. Ordered by `archivedAt DESC`
   * (most-recently archived first) with a stable `key ASC` tiebreak so OFFSET
   * paging is deterministic, and windowed by `page` (LIMIT/OFFSET) so it never
   * ships the whole archive. The archiver is resolved in the SAME read via a
   * LATERAL pick of the latest `'archived'` revision joined to `user`. Read-only
   * path → `db` singleton.
   */
  async findArchivedByProject(
    projectId: string,
    workspaceId: string,
    page: { limit: number; offset: number },
    tx?: Prisma.TransactionClient,
  ): Promise<ArchivedWorkItemRow[]> {
    const client = tx ?? db;
    return client.$queryRaw<ArchivedWorkItemRow[]>`
      SELECT w."id",
             w."kind"::text       AS "kind",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."updatedAt",
             w."archivedAt",
             ar."changedById"     AS "archivedById",
             abu."name"           AS "archivedByName",
             abu."image"          AS "archivedByImage"
        FROM "work_item" w
        LEFT JOIN LATERAL (
          SELECT r."changedById"
            FROM "work_item_revision" r
            WHERE r."workItemId" = w."id"
              AND r."changeKind" = 'archived'
            ORDER BY r."changedAt" DESC
            LIMIT 1
        ) ar ON TRUE
        LEFT JOIN "user" abu ON abu."id" = ar."changedById"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NOT NULL
          AND ${notInTriageSql('w')}
        ORDER BY w."archivedAt" DESC, w."key" ASC
        LIMIT ${page.limit} OFFSET ${page.offset}`;
  },

  /**
   * COUNT of a project's ARCHIVED items (Subtask 2.9.2) — the denominator of the
   * archive view's pager, the same `projectId` + `workspaceId` + triage gate as
   * {@link findArchivedByProject} but counting the `archivedAt IS NOT NULL` set.
   * `::int` casts Postgres' `bigint`. Read-only path → `db` singleton.
   */
  async countArchivedByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NOT NULL
          AND ${notInTriageSql('w')}`;
    return rows[0]?.count ?? 0;
  },

  /**
   * Count a project's non-archived, non-triage work items grouped by workflow
   * status CATEGORY (Story 6.12 · Subtask 6.12.4) — the Overview stat strip's
   * Planned / In progress / Shipped denominators, in ONE aggregate (no
   * per-category round-trip). Joins `workflow_status` to resolve each item's
   * `status` key → its category (`todo` / `in_progress` / `done`); an item whose
   * status maps to no live workflow status falls outside every bucket (omitted),
   * same as the board's unmapped handling. The explicit `workspaceId` gate is
   * the app-layer tenancy check atop RLS (finding #26). Read-only → `db`
   * singleton. Returns a per-category count map (absent categories ⇒ 0).
   */
  async countByStatusCategory(
    projectId: string,
    workspaceId: string,
    opts: { excludeIds?: readonly string[] } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<{ todo: number; in_progress: number; done: number }> {
    const client = tx ?? db;
    const rows = await client.$queryRaw<Array<{ category: string; count: number }>>`
      SELECT ws."category"::text AS "category", COUNT(*)::int AS "count"
        FROM "work_item" w
        JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', opts.excludeIds)}
        GROUP BY ws."category"`;
    const out = { todo: 0, in_progress: 0, done: 0 };
    for (const r of rows) {
      if (r.category === 'todo' || r.category === 'in_progress' || r.category === 'done') {
        out[r.category] = r.count;
      }
    }
    return out;
  },

  /**
   * Count a project's TRIAGE-queued items (Story 6.12 · Subtask 6.12.4) — the
   * Overview "Public requests" stat. Triage items are the submission inbox
   * (`triagedAt IS NOT NULL`), which 6.12.5's public submit feeds; today this is
   * typically 0. Archived items are excluded. Read-only → `db` singleton.
   */
  async countTriageItems(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.workItem.count({
      where: { projectId, workspaceId, archivedAt: null, triagedAt: { not: null } },
    });
  },

  /**
   * The BOUNDED card set of a board column (Subtask 3.1.4 / 3.8.2, finding #57):
   * a project's non-archived work items whose `status` is one of `statusKeys`
   * (the column's mapped statuses), ordered for the board and capped with `take`
   * so the projection never ships an unbounded column. `order` is whitelisted
   * (NOT user input): `'position'` ranks by the board rank (`position` asc — the
   * fractional-index string sorts lexicographically) for an active column;
   * `'recent'` orders by `updatedAt` desc for a terminal (done) column, so its
   * bounded window is the most-recent work. A stable `key` asc tiebreak keeps
   * the order total/deterministic.
   *
   * `opts.limit` caps the load at the board-level cap (Subtask 3.8.2 — there is
   * no more per-column cursor paging; the whole bounded set loads at once and
   * virtualizes client-side). `opts.updatedSince`, when present, applies the
   * **Done-age window** (3.8.2): only cards touched on/after that instant load —
   * the age-based shape Jira uses for terminal columns, while the FULL count is
   * still surfaced separately via `countProjectIssues`. The explicit `projectId`
   * + `workspaceId` gate is the app-layer tenancy check atop RLS (finding #26).
   * Empty `statusKeys` short-circuits to `[]` (a column mapping no live status
   * has no cards). Read-only → `db` singleton (optional `tx`).
   */
  async findColumnCards(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    order: 'position' | 'recent',
    opts: {
      limit: number;
      updatedSince?: Date;
      sprintId?: string;
      // The advanced board filter (Story 6.15.2) — a compiled FilterAST AND-ed
      // into the card read so a column shows ONLY matching cards. Omitted on the
      // unfiltered board (the byte-for-byte 3.8.2 builder read below).
      ast?: FilterAst;
      referents?: ProjectFilterReferents;
      // Epic-privacy public exclusion (Story 6.14 · Subtask 6.14.4) — drop
      // descendants of a private epic for a non-member viewer (resolved by
      // `findPublicHiddenDescendantIds`). Absent/empty ⇒ no clause (the internal
      // board + the no-private-epic case read the unchanged projection).
      excludeIds?: readonly string[];
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (statusKeys.length === 0) return [];
    const client = tx ?? db;

    // Advanced filter active (Story 6.15.2): AND the compiled FilterAST (alias
    // `w`) into the column read. The AST can't be expressed through the Prisma
    // query builder — it compiles to a parameterized SQL fragment over the full
    // row (incl. the 6.1.2 label/component/custom-field EXISTS probes) — so we
    // resolve the matching, ordered, capped ids in ONE raw query that applies
    // the SAME base predicates as the builder path, then hydrate the real
    // `WorkItem` rows through the builder (keeping the row type exact for the
    // board mapper) and restore the raw query's order. No AST → the existing
    // builder read, byte-for-byte the 3.8.2 projection (no regression).
    if (opts.ast && opts.ast.conditions.length > 0) {
      const orderSql =
        order === 'recent'
          ? Prisma.sql`w."updatedAt" DESC, w."key" ASC`
          : Prisma.sql`w."position" ASC, w."key" ASC`;
      // Bind the cutoff as a JS Date param (never SQL NOW()) so the comparison
      // stays timestamptz-correct, mirroring `aggregateCreatedByBucket`.
      const updatedSinceSql = opts.updatedSince
        ? Prisma.sql`AND w."updatedAt" >= ${opts.updatedSince}`
        : Prisma.empty;
      const sprintScope = opts.sprintId
        ? Prisma.sql`AND w."sprintId" = ${opts.sprintId}`
        : Prisma.empty;
      const idRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT w."id"
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            AND w."status" = ANY(${statusKeys})
            ${updatedSinceSql}
            ${sprintScope}
            AND ${notExcludedSql('w', opts.excludeIds)}
            AND (${compileFilterConditionsSql(opts.ast, opts.referents)})
          ORDER BY ${orderSql}
          LIMIT ${opts.limit}`;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await client.workItem.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // `findMany({ id: { in } })` does not preserve the id list order — restore
      // the raw query's order/window so the board rank is honoured.
      return ids.map((id) => byId.get(id)).filter((r): r is WorkItem => r !== undefined);
    }

    const orderBy: Prisma.WorkItemOrderByWithRelationInput[] =
      order === 'recent'
        ? [{ updatedAt: 'desc' }, { key: 'asc' }]
        : [{ position: 'asc' }, { key: 'asc' }];
    return client.workItem.findMany({
      where: {
        projectId,
        workspaceId,
        archivedAt: null,
        // Read-exclusion (Subtask 6.11.3): a triage item never appears as a
        // board card — same predicate as the swimlane lane aggregates below.
        triagedAt: null,
        status: { in: statusKeys },
        ...(opts.updatedSince ? { updatedAt: { gte: opts.updatedSince } } : {}),
        // Sprint scope (Story 4.5.2) — a SCRUM board's projection passes the
        // active sprint's id so the column loads only that sprint's issues; a
        // kanban board omits it (unscoped, byte-for-byte the 3.1.4 load).
        ...(opts.sprintId ? { sprintId: opts.sprintId } : {}),
        // Epic-privacy public exclusion (Subtask 6.14.4) — drop a private epic's
        // descendants for a non-member viewer; empty ⇒ no clause.
        ...(opts.excludeIds && opts.excludeIds.length > 0
          ? { id: { notIn: opts.excludeIds as string[] } }
          : {}),
      },
      orderBy,
      take: opts.limit,
    });
  },

  /**
   * One LAZY tree level (Subtask 2.5.13, finding #57) — the project's ROOTS
   * (`parentId === null`) or one parent's DIRECT children (`parentId === <id>`),
   * sorted by the whitelisted column + paged with `take`/`offset`. Each row
   * carries `hasChildren` (a correlated `EXISTS` over non-archived children) so
   * the client renders the expand chevron WITHOUT loading the subtree — the fix
   * for the whole-forest read that didn't scale.
   *
   * The explicit `workspaceId` + `projectId` gate (finding #26 — RLS is inert
   * under the dev/CI superuser) means a row can never cross tenants. The sort
   * column is whitelisted through `ISSUE_SORT_SQL` (never raw user input), and
   * `key ASC` is the stable tiebreaker that makes the order total (so paging
   * never skips/repeats a row). Fetches `take + 1` so the caller can derive
   * `hasMore` without a separate COUNT. UNfiltered only — a filtered tree uses
   * `findProjectForest` (context-preserving over the bounded result).
   */
  async findProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    sort: IssueSort,
    page: { take: number; offset: number },
    sprintId: string | null = null,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemTreeRow[]> {
    const client = tx ?? db;
    const orderCol = ISSUE_SORT_SQL[sort.column];
    const dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;
    // Sprint scope (MOTIR-1381): when `sprintId` is set, narrow BOTH the level's
    // rows AND the `hasChildren` probe to the member-or-ancestor set, so a
    // container with no in-sprint descendants reports no drillable children and a
    // fully-out-of-sprint branch never appears. `null` ⇒ `TRUE` (whole project).
    const rowSprintScope = inSprintScopeSql('w', projectId, workspaceId, sprintId);
    const childSprintScope = inSprintScopeSql('ch', projectId, workspaceId, sprintId);

    return client.$queryRaw<WorkItemTreeRow[]>`
      SELECT w."id",
             w."parentId",
             w."kind"::text       AS "kind",
             w."type"::text       AS "type",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."updatedAt",
             EXISTS (
               SELECT 1 FROM "work_item" ch
                WHERE ch."parentId" = w."id" AND ch."archivedAt" IS NULL
                  AND ${notInTriageSql('ch')}
                  AND ${childSprintScope}
             )                    AS "hasChildren"
        FROM "work_item" w
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        LEFT JOIN "user" ru ON ru."id" = w."reporterId"
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${rowSprintScope}
          AND ${parentPred}
        ORDER BY ${orderCol} ${dir} NULLS LAST, w."key" ASC
        LIMIT ${page.take + 1} OFFSET ${page.offset}`;
  },

  /**
   * The FULL child count of one lazy tree level (Subtask 2.5.14) — the project's
   * roots (`parentId === null`) or a parent's direct children — for an honest
   * `aria-setsize` ("19 of 128") + the "Showing N of M" affordance, independent
   * of paging. Same `workspaceId`+`projectId` gate as `findProjectTreeLevel`.
   * COUNT comes back as `bigint`; coerced to `number` (a project's per-node
   * child count is well within `Number.MAX_SAFE_INTEGER`).
   */
  async countProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;
    const rows = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${parentPred}`;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * One LAZY level of the PUBLIC work-item TREE (Story 6.14 · Subtask 6.14.10) —
   * the project's roots (`parentId === null`) or one parent's DIRECT children,
   * key-ordered + paged with `take`/`offset`, projected to the PUBLIC-safe
   * columns only (the {@link PublicWorkItemTreeRow} shape — no assignee /
   * estimate / story points / reporter is SELECTed, so the public boundary is
   * structural). `excludeIds` is the epic-privacy exclusion set (6.14.4): a
   * non-member's level drops every descendant of a private epic — both the rows
   * AND the `hasChildren` EXISTS probe exclude them, so a private epic reports
   * `hasChildren = false` (its placeholder chevron is driven by
   * `publicChildrenHidden`, the mapper's marker). A member passes `[]`, reading
   * the unfiltered tree.
   *
   * The explicit `workspaceId` + `projectId` gate (finding #26 — RLS is inert
   * under the dev/CI superuser) means a row can never cross tenants. `key ASC` is
   * a total order, so paging never skips/repeats a row. Fetches `take + 1` so the
   * caller derives `hasMore` without a separate COUNT. UNfiltered + UNsorted
   * (the public tree has no sort headers) — the read mirrors
   * {@link findProjectTreeLevel} minus the internal columns + the user joins.
   */
  async findPublicProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    page: { take: number; offset: number },
    excludeIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<PublicWorkItemTreeRow[]> {
    const client = tx ?? db;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;

    return client.$queryRaw<PublicWorkItemTreeRow[]>`
      SELECT w."id",
             w."parentId",
             w."kind"::text       AS "kind",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text   AS "priority",
             w."publicChildrenHidden",
             EXISTS (
               SELECT 1 FROM "work_item" ch
                WHERE ch."parentId" = w."id" AND ch."archivedAt" IS NULL
                  AND ${notInTriageSql('ch')}
                  AND ${notExcludedSql('ch', excludeIds)}
             )                    AS "hasChildren"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', excludeIds)}
          AND ${parentPred}
        ORDER BY w."key" ASC
        LIMIT ${page.take + 1} OFFSET ${page.offset}`;
  },

  /**
   * The FULL child count of one PUBLIC tree level (Subtask 6.14.10) — the
   * project's roots or a parent's direct children — for an honest
   * `aria-setsize` / "Showing N of M", independent of paging. Same
   * `workspaceId`+`projectId` + epic-privacy `excludeIds` exclusion as
   * {@link findPublicProjectTreeLevel} (so the denominator never counts a hidden
   * descendant — an aggregate-tell leak). COUNT → `bigint`, coerced to `number`.
   */
  async countPublicProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    excludeIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;
    const rows = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', excludeIds)}
          AND ${parentPred}`;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Create a work item. Required `tx`. The DB triggers validate the
   * kind-parent matrix + depth on insert; their SQLSTATE-23514 rejections and
   * a P2002 unique violation are translated to typed errors here.
   */
  async create(
    data: Prisma.WorkItemUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.create({ data });
    } catch (err) {
      throw translateWriteError(err);
    }
  },

  /**
   * Count ALL work items across an organization (§4.1 headline cap, 8.1.11) —
   * every project in every workspace of the org, joined `work_item → workspace`.
   * A PLAIN ROW COUNT with NO archive filter: §4 counts archived AND active
   * items ("archiving does NOT free room" — the deliberate divergence from
   * Linear's non-archived cap that closes the archive loophole). Takes `tx` so
   * the count + the guarded create run in one transaction, serialized by the org
   * row lock (`organizationRepository.lockByIdForUpdate`). Raw SQL because the
   * count crosses the workspace join at the org boundary (the ungameable org-wide
   * count §4 mandates), not the active-workspace scope a Prisma `count` sees.
   */
  async countByOrganization(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM "work_item" wi
      JOIN "workspace" w ON w."id" = wi."workspaceId"
      WHERE w."organizationId" = ${organizationId}
    `;
    return Number(rows[0]?.count ?? 0);
  },

  // --- Board swimlane lane aggregates (Subtask 3.3.4, finding #57) ----------
  // Each returns one row PER LANE (a grouped/distinct aggregate), NOT one row
  // per card — so the board never fetches every card to discover its lanes.
  // `statusKeys` is the union of the board's mapped column statuses (a card on
  // the board has a status in this set); an empty set short-circuits.
  //
  // `sprintId` (Story 4.5.2) is the optional SCRUM scope: when present the lane
  // aggregate counts only the active sprint's issues, so swimlanes compose with
  // the sprint filter exactly as the columns do; omitted on a kanban board
  // (unscoped, byte-for-byte the 3.3.4 lane counts).

  /**
   * Per-assignee card counts among the board's cards — one row per distinct
   * `assigneeId` (incl. `null` = the unassigned/catch-all bucket). The service
   * resolves the null bucket + the assignee display names into lane DTOs.
   */
  async aggregateBoardLanesByAssignee(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    sprintId?: string,
    filter?: BoardCardFilter,
  ): Promise<Array<{ assigneeId: string | null; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Raw GROUP BY (not the Prisma builder) so the optional 6.15.2 FilterAST —
    // a parameterized SQL fragment over alias `w` — can be AND-ed in; the lane
    // counts then track the FILTERED board exactly as `findColumnCards` does.
    // No filter → the fragment is `TRUE`, so the counts are byte-for-byte the
    // 3.3.4 aggregate. Read-exclusion (6.11.3): a triage item never counts.
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    return db.$queryRaw<Array<{ assigneeId: string | null; count: number }>>`
      SELECT w."assigneeId" AS "assigneeId", COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND w."status" = ANY(${statusKeys})
          ${sprintScope}
          AND (${boardCardFilterSql(filter)})
        GROUP BY w."assigneeId"`;
  },

  /**
   * Per-priority card counts among the board's cards — one row per distinct
   * `priority`. `priority` is non-null (default `medium`), so there is no
   * catch-all lane for this dimension.
   */
  async aggregateBoardLanesByPriority(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    sprintId?: string,
    filter?: BoardCardFilter,
  ): Promise<Array<{ priority: WorkItemPriority; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Raw GROUP BY so the optional 6.15.2 FilterAST AND-s in (see
    // `aggregateBoardLanesByAssignee`); `priority::text` returns the enum's
    // string value (= the WorkItemPriority union members), so the shape matches
    // the prior `groupBy` result. No filter → `TRUE` (byte-for-byte 3.3.4).
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    return db.$queryRaw<Array<{ priority: WorkItemPriority; count: number }>>`
      SELECT w."priority"::text AS "priority", COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND w."status" = ANY(${statusKeys})
          ${sprintScope}
          AND (${boardCardFilterSql(filter)})
        GROUP BY w."priority"`;
  },

  /**
   * Per-ANCESTOR-EPIC card counts among the board's cards — one row per epic
   * that is the nearest epic ancestor of at least one board card. A recursive
   * CTE walks each card UP its `parentId` chain, stopping at the first `epic`
   * (an epic has no epic ancestor, so each card maps to AT MOST one epic), then
   * GROUPs in SQL — so this returns lane rows, never a row per card (finding
   * #57). A card whose chain has no epic contributes no row here; the service
   * derives the "No epic" catch-all count by subtraction (total − Σ epic
   * counts). A board card that IS an epic counts in its own lane.
   * `workspaceId` is filtered on both the anchor and the climb (no cross-tenant
   * leak).
   */
  async aggregateBoardLanesByEpic(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    sprintId?: string,
    filter?: BoardCardFilter,
  ): Promise<Array<{ epicId: string; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Sprint scope (Story 4.5.2): only the anchor (the board CARDS) is sprint-
    // filtered; the upward climb to the ancestor epic must NOT be (an epic
    // ancestor is rarely itself in the sprint). Bound param, never interpolated.
    // The 6.15.2 FilterAST likewise constrains only the anchor CARDS (the climb
    // is structural) — so the epic lanes/counts track the FILTERED board. No
    // filter → `TRUE` (byte-for-byte the 3.3.4 epic aggregate).
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    return db.$queryRaw<Array<{ epicId: string; count: number }>>`
      WITH RECURSIVE up AS (
        SELECT w."id" AS card_id, w."id" AS node_id, w."parentId", w."kind"::text AS kind
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            AND w."status" = ANY(${statusKeys})
            ${sprintScope}
            AND (${boardCardFilterSql(filter)})
        UNION ALL
        SELECT u.card_id, p."id", p."parentId", p."kind"::text
          FROM up u
          JOIN "work_item" p ON p."id" = u."parentId" AND p."workspaceId" = ${workspaceId}
          WHERE u.kind <> 'epic'
      )
      SELECT node_id AS "epicId", COUNT(*)::int AS "count"
        FROM up
        WHERE kind = 'epic'
        GROUP BY node_id`;
  },

  /**
   * Does one work item satisfy an automation rule's condition group (Story 6.6
   * · Subtask 6.6.2)? Compiles the FilterAST through the 6.1.1 compiler over
   * alias `w` (stale referents → match-nothing, the 6.1.2 rule) and tests it
   * against the SINGLE triggering item — `WHERE w.id = :id AND (<conditions>)`,
   * one indexed point read. An empty condition group compiles to `TRUE`, so the
   * predicate reduces to "the item still exists" (the always-match rule). A
   * deleted/missing item returns false (it can't be acted on). Read-only path →
   * `db` singleton (the engine has no surrounding write tx when it evaluates).
   */
  async matchesAutomationCondition(
    workItemId: string,
    ast: FilterAst,
    referents?: ProjectFilterReferents,
  ): Promise<boolean> {
    const astSql = compileFilterConditionsSql(ast, referents);
    const rows = await db.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM "work_item" w
      WHERE w."id" = ${workItemId} AND (${astSql})
      LIMIT 1`;
    return rows.length > 0;
  },

  /**
   * The CREATED series of the created-vs-resolved report (Story 6.3 · Subtask
   * 6.3.2): non-archived items whose `createdAt` falls inside the inclusive
   * window, COUNTed per `date_trunc(period, createdAt)` bucket in ONE grouped
   * query (finding #57 — never a row load + JS reduce; the result is bounded
   * by the bucket cap the service validates). `period` is a closed
   * `day|week|month` union bound as a parameter (never SQL text). The
   * optional compiled FilterAST (the 6.2 saved-filter scope — Subtask 6.1.1's
   * compiler over alias `w`, stale referents → match-nothing per 6.1.2)
   * narrows the set; a project scope passes none. `workspaceId` gates the
   * read (finding #26). Buckets with no events return no row (the service
   * fills the axis). Read-only path → `db` singleton.
   */
  async aggregateCreatedByBucket(
    projectId: string,
    workspaceId: string,
    period: 'day' | 'week' | 'month',
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
  ): Promise<Array<{ bucket: string; count: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    return db.$queryRaw<Array<{ bucket: string; count: number }>>`
      SELECT
        to_char(date_trunc(${period}, w."createdAt"), 'YYYY-MM-DD') AS "bucket",
        COUNT(*)::int AS "count"
      FROM "work_item" w
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND w."createdAt" >= ${window.start}
        AND w."createdAt" <= ${window.end}
        AND (${astSql})
      GROUP BY 1
      ORDER BY 1`;
  },

  /**
   * The DISTRIBUTION (donut) aggregate (Story 6.3 · Subtask 6.3.2): one
   * bounded GROUP-BY count over the scoped non-archived items, per the TOTAL
   * `DistributionGroupBy` descriptor (`lib/reports/statisticTypes.ts` —
   * mistake #29: the switch below is total over every descriptor the
   * registry can emit; descriptors select FIXED SQL literals, only values
   * bind). Strategies:
   *   • `column` — a `work_item` scalar (kind/status/priority/assignee/
   *     reporter/sprint), labelled via its referent table where one exists
   *     (workflow_status label, user/sprint name; enum ids self-describe).
   *   • `join` — the 5.4.1 label/component join: one row per (item, join
   *     row), so a multi-labelled item lands in multiple segments (the
   *     verified Jira behaviour) and a no-label item falls into the NULL
   *     ("None") segment via LEFT JOIN.
   *   • `customField` — the 5.3.1 typed-EAV probe on the `[workItemId,
   *     fieldId]` unique / `[fieldId, value*]` indexes, narrowed to the
   *     enum-ish value columns (select-option / user).
   * The optional compiled FilterAST narrows the item set (the saved-filter
   * scope). The result is bounded by the statistic's value vocabulary —
   * segments, never items (finding #57). Read-only path → `db` singleton.
   */
  async aggregateDistribution(
    projectId: string,
    workspaceId: string,
    groupBy: DistributionGroupBy,
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
  ): Promise<Array<{ id: string | null; label: string | null; count: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const { idExpr, labelExpr, joinSql } = distributionGroupBySql(groupBy);
    return db.$queryRaw<Array<{ id: string | null; label: string | null; count: number }>>`
      SELECT ${idExpr} AS "id", ${labelExpr} AS "label", COUNT(*)::int AS "count"
      FROM "work_item" w
      ${joinSql}
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND (${astSql})
      GROUP BY 1, 2
      ORDER BY 3 DESC, 2 ASC NULLS LAST, 1 ASC NULLS LAST`;
  },

  /**
   * The WORKLOAD aggregate (Story 8.8 · Subtask 8.8.13): one bounded GROUP-BY
   * over the scoped, non-archived, NON-triage, OPEN (current status NOT in a
   * `done`-category) `work_item` rows, per `assigneeId` — both the summed
   * `storyPoints` (an unestimated item contributes 0, never `NaN`) and the issue
   * COUNT, so the Measure toggle (story points ↔ issue count) is a client re-rank
   * with no refetch. The unassigned bucket is the `NULL` `assigneeId` row
   * (LEFT-joined name `NULL` — the UI's neutral "None"). "Done" resolves like
   * every report: join `workflow_status` on the item's CURRENT status key and
   * read `category = 'done'` (a `NULL` join — a status with no matching row —
   * counts as open, never silently dropped). The optional compiled FilterAST
   * (the 6.2 saved-filter scope) narrows the set; a project scope passes none.
   * `workspaceId` gates the read (finding #26). Bounded by the team size
   * (segments, never items — finding #57). Read-only path → `db` singleton.
   */
  async aggregateWorkloadByAssignee(
    projectId: string,
    workspaceId: string,
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
  ): Promise<
    Array<{ assigneeId: string | null; name: string | null; points: number; count: number }>
  > {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    return db.$queryRaw<
      Array<{ assigneeId: string | null; name: string | null; points: number; count: number }>
    >`
      SELECT
        w."assigneeId"                          AS "assigneeId",
        au."name"                               AS "name",
        COALESCE(SUM(w."storyPoints"), 0)::float8 AS "points",
        COUNT(*)::int                           AS "count"
      FROM "work_item" w
      LEFT JOIN "user" au ON au."id" = w."assigneeId"
      LEFT JOIN "workflow_status" cs
        ON cs."project_id" = w."projectId"
       AND cs."key" = w."status"
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND (cs."category" IS NULL OR cs."category" <> 'done')
        AND (${astSql})
      GROUP BY 1, 2
      ORDER BY "points" DESC, "count" DESC, 2 ASC NULLS LAST, 1 ASC NULLS LAST`;
  },

  /**
   * Resolve the nearest ANCESTOR-EPIC id for each of `itemIds` (the loaded
   * board page) — the per-card half of the epic group-by, so the client never
   * re-derives lane membership. Same upward recursive walk as
   * `aggregateBoardLanesByEpic`, but anchored on a BOUNDED id set (≤ the loaded
   * page) and returning (card → epic) pairs instead of grouping. A card with no
   * epic ancestor yields no row (the service buckets it into the catch-all).
   */
  async findEpicAncestors(
    itemIds: string[],
    workspaceId: string,
  ): Promise<Array<{ cardId: string; epicId: string }>> {
    if (itemIds.length === 0) return [];
    return db.$queryRaw<Array<{ cardId: string; epicId: string }>>`
      WITH RECURSIVE up AS (
        SELECT w."id" AS card_id, w."id" AS node_id, w."parentId", w."kind"::text AS kind
          FROM "work_item" w
          WHERE w."id" = ANY(${itemIds}) AND w."workspaceId" = ${workspaceId}
        UNION ALL
        SELECT u.card_id, p."id", p."parentId", p."kind"::text
          FROM up u
          JOIN "work_item" p ON p."id" = u."parentId" AND p."workspaceId" = ${workspaceId}
          WHERE u.kind <> 'epic'
      )
      SELECT card_id AS "cardId", node_id AS "epicId"
        FROM up
        WHERE kind = 'epic'`;
  },

  /**
   * Patch a work item. Required `tx`. The triggers re-validate on a
   * parentId/kind change (and reject re-parent cycles); a missing row yields
   * a typed not-found error.
   */
  async update(
    id: string,
    patch: Prisma.WorkItemUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id }, data: patch });
    } catch (err) {
      throw translateWriteError(err, { id });
    }
  },

  /**
   * Soft-delete: stamp `archivedAt = now()`. Work items are NEVER hard-deleted
   * (the Project pattern) — revision history (1.4.6) must survive an archive.
   */
  async archive(id: string, tx: Prisma.TransactionClient): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id }, data: { archivedAt: new Date() } });
    } catch (err) {
      throw translateWriteError(err, { id });
    }
  },

  /**
   * Restore a soft-deleted item — clear `archivedAt` (Subtask 7.8.14, the
   * Jira "restore" action). The inverse of {@link archive}: a single-op update,
   * the same P2025→WorkItemNotFoundError translation. Re-archiving an already-
   * live row (archivedAt already null) is a harmless no-op write.
   */
  async unarchive(id: string, tx: Prisma.TransactionClient): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id }, data: { archivedAt: null } });
    } catch (err) {
      throw translateWriteError(err, { id });
    }
  },

  /**
   * PERMANENT delete of a whole subtree (Story 2.8 · Subtask 2.8.2) — the
   * destructive counterpart of {@link archive}. The caller (`deleteWorkItem`)
   * resolves the full id set via {@link findSubtree} (root + every descendant)
   * and passes it here; this is the single-op leaf that removes them.
   *
   * ONE statement (`deleteMany ... WHERE id IN (...)`) removes the root AND its
   * children together. The self-FK (`work_item.parentId → work_item.id`) is
   * `onDelete: NoAction`, and SQL `NO ACTION` (unlike `RESTRICT`) defers the
   * referential check to END-OF-STATEMENT — so a single delete that removes a
   * parent and all its referencing children passes with no per-level ordering.
   * Every OTHER inbound FK is `Cascade` (links from+to, comments,
   * labels/components/watchers, custom-field values, notifications, votes,
   * revisions, sprint-report entries) or `SetNull` (attachments → orphan-GC,
   * automation-execution audit), so the DB removes/decouples those rows for us:
   * no orphaned links or rows survive. Returns the deleted-row count. Write →
   * `tx` REQUIRED (the service runs it inside its delete transaction). An empty
   * id set short-circuits so we never issue a degenerate `IN ()`.
   */
  async deleteSubtree(ids: string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await tx.workItem.deleteMany({ where: { id: { in: ids } } });
    return r.count;
  },

  // --- Sprint association + backlog rank (Story 4.1 · Subtask 4.1.2) ---------
  // The `work_item` sprint/rank methods live HERE (the entity owns them — the
  // repository-name-matches-entity rule), not in a new repo. `sprintId` /
  // `backlogRank` are camelCase columns on `work_item` (NOT `@map`-ed — within-
  // table consistency, schema rung-2 decision), so raw SQL double-quotes them
  // verbatim. The service (4.1.4) computes the rank via `positioning.ts`; these
  // methods just persist/read it. Bounded reads only — never load-all (finding
  // #57). Writes require `tx`; reads carry the explicit `workspaceId` gate
  // (finding #26).

  /**
   * Associate an issue with a sprint, or move it back to the backlog
   * (`sprintId = null`). Single write; `tx` REQUIRED. The same-project guard
   * and the 1.4.6 revision write are the SERVICE's job (4.1.4) — this is the
   * bare association write.
   */
  async setSprint(
    itemId: string,
    sprintId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id: itemId }, data: { sprintId } });
    } catch (err) {
      throw translateWriteError(err, { id: itemId });
    }
  },

  /**
   * Write an issue's global `backlogRank` (the opaque base-62 fractional index
   * the service computes via `positioning.ts` `keyBetween`). Single write; `tx`
   * REQUIRED. One row changes — there is no N-row renumber (the fractional index
   * is the whole point).
   */
  async setBacklogRank(
    itemId: string,
    rank: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id: itemId }, data: { backlogRank: rank } });
    } catch (err) {
      throw translateWriteError(err, { id: itemId });
    }
  },

  // --- Story points + estimation roll-ups (Story 4.3 · Subtask 4.3.3) --------
  // The agile `storyPoints` estimate lives on `work_item` (the entity owns it —
  // the repository-name-matches-entity rule), SEPARATE from `estimateMinutes`
  // (the TIME estimate, 2.3.6). `storyPoints` is a camelCase column (NOT
  // `@map`-ed — within-table consistency, schema rung-2), so raw SQL
  // double-quotes it verbatim. The roll-ups are BOUNDED aggregates (finding
  // #57) — one grouped/recursive query, NEVER a load-all + client sum. The
  // write requires `tx`; the aggregate reads carry the explicit `workspaceId`
  // gate (finding #26) and take an optional `tx`.

  /**
   * Set or clear (`points = null`) an issue's `storyPoints`. Single write; `tx`
   * REQUIRED. The value validation + the 1.4.6 revision are the SERVICE's job
   * (estimationService) — this is the bare column write. `Prisma.Decimal`
   * accepts a JS `number`, so the service passes the validated number through.
   */
  async setStoryPoints(
    itemId: string,
    points: number | null,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id: itemId }, data: { storyPoints: points } });
    } catch (err) {
      throw translateWriteError(err, { id: itemId });
    }
  },

  /**
   * The BOUNDED sprint points roll-up (finding #57): the configured `statistic`
   * summed over a sprint's non-archived issues, in ONE grouped aggregate.
   * `committed` is the total; `completed` is the same sum scoped — via an
   * aggregate `FILTER` over the LEFT-joined `workflow_status` — to issues whose
   * status maps to a `category = 'done'` workflow status (the finding-#21
   * terminal predicate). The `workspaceId` gate keeps the aggregate
   * tenant-scoped. NULL/empty sums `COALESCE` to 0, so an empty / wholly
   * unestimated sprint returns `{ committed: 0, completed: 0 }` (the single
   * aggregate row always exists). NEVER loads the rows.
   */
  async sumPointsForSprint(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
  ): Promise<{ committed: number; completed: number }> {
    const client = tx ?? db;
    const committed = pointsAggExpr(statistic, 'w', false);
    const completed = pointsAggExpr(statistic, 'w', true);
    const rows = await client.$queryRaw<Array<{ committed: number; completed: number }>>`
      SELECT ${committed}::float8 AS "committed",
             ${completed}::float8 AS "completed"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."sprintId" = ${sprintId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL`;
    return rows[0] ?? { committed: 0, completed: 0 };
  },

  /**
   * The BOUNDED current STARTED sum of a sprint (Story 8.14.4) — the configured
   * `statistic` summed over a sprint's non-archived issues whose status has LEFT
   * the `todo` category (i.e. is in an `in_progress`- OR `done`-category status —
   * "started" in Linear's cycle-graph sense). An aggregate `FILTER` over the
   * LEFT-joined `workflow_status`; a NULL category (no status row) is the initial
   * not-yet-started state and is excluded. The `workspaceId` gate keeps it
   * tenant-scoped; the sum `COALESCE`s to 0 (the single aggregate row always
   * exists). Used to ANCHOR the cycle graph's started series to the live present
   * (`startedAtStart = currentStarted − Σ startedDelta`). NEVER loads the rows.
   */
  async sumStartedForSprint(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
  ): Promise<number> {
    const startedFilter = Prisma.sql` FILTER (WHERE ws."category" IS NOT NULL AND ws."category" <> 'todo')`;
    const expr =
      statistic === 'issue_count'
        ? Prisma.sql`COUNT(*)${startedFilter}`
        : statistic === 'story_points'
          ? Prisma.sql`COALESCE(SUM(w."storyPoints")${startedFilter}, 0)`
          : Prisma.sql`COALESCE(SUM(w."estimateMinutes")${startedFilter}, 0)`;
    const rows = await db.$queryRaw<Array<{ started: number }>>`
      SELECT ${expr}::float8 AS "started"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."sprintId" = ${sprintId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL`;
    return rows[0]?.started ?? 0;
  },

  /**
   * The BOUNDED per-STATUS points breakdown of a sprint (Story 4.5.2) — the
   * configured `statistic` summed over the sprint's non-archived issues, GROUPED
   * by `work_item.status`, in ONE grouped aggregate (never a load-all + client
   * sum, finding #57). The board service folds these per-status sums into the
   * scrum board's `columnPoints` (one column = a set of mapped statuses), so the
   * per-column "sprint health" total comes from the DB, not the loaded card
   * page. A status with no estimated points sums to 0 (the `COALESCE` in
   * `pointsAggExpr`); a status with no sprint issues yields no row (the service
   * defaults an absent column to 0). `workspaceId` is the tenant gate (finding
   * #26). Returns one row per distinct status present in the sprint.
   */
  async sumPointsBySprintAndStatus(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ status: string; points: number }>> {
    const client = tx ?? db;
    const points = pointsAggExpr(statistic, 'w', false);
    return client.$queryRaw<Array<{ status: string; points: number }>>`
      SELECT w."status" AS "status",
             ${points}::float8 AS "points"
        FROM "work_item" w
       WHERE w."sprintId" = ${sprintId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL
       GROUP BY w."status"`;
  },

  /**
   * The BOUNDED epic/parent subtree roll-up (finding #57): the configured
   * `statistic` summed over the parent's DESCENDANTS at any depth, via a
   * recursive CTE walking DOWN the `parentId` edge — in ONE query, never a
   * load-the-subtree-and-sum. The anchor is the parent's DIRECT children (the
   * parent's own estimate is excluded — a roll-up of descendants), and the
   * recursion + the `workspaceId` gate on both the anchor and the recursive
   * step keep it tenant-scoped (finding #26). An empty subtree → `{ total: 0 }`
   * (the COALESCE/COUNT over zero rows). The walk is naturally bounded (the tree
   * depth is capped at 4, Story 1.4).
   */
  async sumPointsForParent(
    parentId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
  ): Promise<{ total: number }> {
    const client = tx ?? db;
    const total = pointsAggExpr(statistic, 's', false);
    const rows = await client.$queryRaw<Array<{ total: number }>>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."storyPoints", w."estimateMinutes"
          FROM "work_item" w
          WHERE w."parentId" = ${parentId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
        UNION ALL
        SELECT c."id", c."storyPoints", c."estimateMinutes"
          FROM "work_item" c
          JOIN subtree p ON c."parentId" = p."id"
          WHERE c."workspaceId" = ${workspaceId}
            AND c."archivedAt" IS NULL
      )
      SELECT ${total}::float8 AS "total" FROM subtree s`;
    return rows[0] ?? { total: 0 };
  },

  /**
   * One bounded page of a project's BACKLOG — non-archived issues with
   * `sprintId IS NULL`, in `backlogRank` order (the `(projectId, sprintId,
   * backlogRank)` composite index, 4.1.1). Fetches `take + 1` so the service can
   * tell whether a next page exists and derive the next cursor (finding #57 —
   * NEVER load-all). `cursor` is a work-item id; the row at the cursor is skipped
   * so paging doesn't repeat it. `id` is the orderBy tiebreaker (backlogRank is
   * unique in practice, but the tiebreaker keeps the cursor walk total).
   */
  async findBacklogPage(
    projectId: string,
    workspaceId: string,
    options: {
      take: number;
      cursor?: string;
      excludeStatusKeys?: string[];
      // The shared backlog filter (Story 8.8 · Subtask 8.8.17) — a compiled
      // FilterAST AND-ed into the page read so the backlog shows only matching
      // issues. Omitted on the unfiltered backlog (the byte-for-byte 4.1.1
      // builder read below). Resolved by `backlogService.resolveBacklogFilter`.
      filter?: { ast: FilterAst; referents?: ProjectFilterReferents };
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take, cursor, excludeStatusKeys = [], filter } = options;

    // Advanced filter active (Subtask 8.8.17): AND the compiled FilterAST (alias
    // `w`) into the page read. The AST can't be expressed through the Prisma
    // query builder — it compiles to a parameterized SQL fragment over the full
    // row (incl. the 6.1.2 label/component/custom-field EXISTS probes) — so we
    // resolve the matching, seek-paginated, capped ids in ONE raw query that
    // applies the SAME base predicates as the builder path, then hydrate the
    // real `WorkItem` rows through Prisma and restore the raw query's order (the
    // 6.15.2 `findColumnCards` precedent, exactly). No filter → the existing
    // builder read, byte-for-byte the 4.1.1 projection (no regression).
    if (filter && filter.ast.conditions.length > 0) {
      const excludeSql =
        excludeStatusKeys.length > 0
          ? Prisma.sql`AND w."status" <> ALL(${excludeStatusKeys})`
          : Prisma.empty;
      // The seek predicate replicates Prisma's `cursor: { id }, skip: 1` over
      // `orderBy [backlogRank asc, id asc]`: continue STRICTLY AFTER the cursor
      // row in (backlogRank, id) order. The cursor row's keys are read by id
      // (its filter-match is irrelevant — the page boundary is filter-
      // independent, exactly as Prisma's cursor). The row-value `>` gives the
      // lexicographic (backlogRank, id) walk; both columns are text, so it
      // sorts identically to the Prisma orderBy.
      const cursorSql = cursor
        ? Prisma.sql`AND (w."backlogRank", w."id") > (
            SELECT c."backlogRank", c."id" FROM "work_item" c WHERE c."id" = ${cursor}
          )`
        : Prisma.empty;
      const idRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT w."id"
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."sprintId" IS NULL
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            ${excludeSql}
            ${cursorSql}
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})
          ORDER BY w."backlogRank" ASC, w."id" ASC
          LIMIT ${take + 1}`;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await client.workItem.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // `findMany({ id: { in } })` does not preserve the id list order — restore
      // the raw query's (backlogRank, id) seek order + window.
      return ids.map((id) => byId.get(id)).filter((r): r is WorkItem => r !== undefined);
    }

    return client.workItem.findMany({
      where: {
        projectId,
        workspaceId,
        sprintId: null,
        archivedAt: null,
        // Read-exclusion (Subtask 6.11.3): a triage item is created parentless +
        // unsprinted, so without this it would surface in the backlog (a core
        // planning surface). The marker keeps it out until accept/promote.
        triagedAt: null,
        // The backlog is the to-be-planned pile, so issues in a `done`-category
        // status are excluded (mirror rung 1: Jira hides the Done column from the
        // backlog; in-progress unsprinted issues stay). The service passes the
        // project's done-category status keys; none → no filter.
        ...(excludeStatusKeys.length > 0 ? { status: { notIn: excludeStatusKeys } } : {}),
      },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Total count of a project's backlog (non-archived, `sprintId IS NULL`, not in
   * a `done`-category status) — the "N issues" header the 4.2 backlog UI shows.
   * Scope matches `findBacklogPage` exactly (same `excludeStatusKeys`). Carries
   * the explicit `workspaceId` gate.
   */
  async countBacklog(
    projectId: string,
    workspaceId: string,
    excludeStatusKeys: string[] = [],
    // The same shared backlog filter `findBacklogPage` takes (Subtask 8.8.17):
    // when present the count is the FILTERED total (the "N issues" header tracks
    // the filtered page). Omitted → the byte-for-byte 4.1.1 Prisma count.
    filter?: { ast: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;

    // Filtered total (Subtask 8.8.17): COUNT over the SAME base predicates as
    // `findBacklogPage`'s raw read with the compiled FilterAST AND-ed in, so the
    // header denominator matches the filtered page exactly.
    if (filter && filter.ast.conditions.length > 0) {
      const excludeSql =
        excludeStatusKeys.length > 0
          ? Prisma.sql`AND w."status" <> ALL(${excludeStatusKeys})`
          : Prisma.empty;
      const rows = await client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."sprintId" IS NULL
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            ${excludeSql}
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})`;
      return rows[0]?.count ?? 0;
    }

    return client.workItem.count({
      where: {
        projectId,
        workspaceId,
        sprintId: null,
        archivedAt: null,
        triagedAt: null, // read-exclusion (6.11.3) — matches findBacklogPage
        ...(excludeStatusKeys.length > 0 ? { status: { notIn: excludeStatusKeys } } : {}),
      },
    });
  },

  /**
   * A sprint's non-archived issues, in `backlogRank` order (the one global rank
   * field orders within a sprint too). A sprint is smaller than the backlog, but
   * the read is still bounded by `take` (paged-capable, not unbounded — finding
   * #57). `workspaceId` gates the read.
   */
  async findSprintIssues(
    sprintId: string,
    workspaceId: string,
    options: {
      take: number;
      cursor?: string;
      // The shared backlog filter (Story 8.8 · Subtask 8.8.20) — a compiled
      // FilterAST AND-ed into the sprint page read so a filtered backlog
      // re-projects its sprint containers too (the 8.8.16 design). Omitted on the
      // unfiltered read (the byte-for-byte 4.1.4 builder read below). Resolved by
      // `backlogService.resolveBacklogFilter`, exactly as `findBacklogPage`.
      filter?: { ast: FilterAst; referents?: ProjectFilterReferents };
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take, cursor, filter } = options;

    // Advanced filter active (Subtask 8.8.20): AND the compiled FilterAST (alias
    // `w`) into the page read — the SAME raw-id-then-hydrate shape `findBacklogPage`
    // uses (the 6.15.2 `findColumnCards` precedent). The sprint base predicate
    // differs from the backlog's: `sprintId = X` (not `IS NULL`), and a sprint
    // KEEPS its done + triage-free issues (no `excludeStatusKeys` / `notInTriage`
    // — a sprint shows its whole committed set, matching the unfiltered read
    // below; `getSprintIssues` keeps done issues). No filter → the existing
    // builder read, byte-for-byte the 4.1.4 projection (no regression).
    if (filter && filter.ast.conditions.length > 0) {
      // Same seek predicate as `findBacklogPage`: continue STRICTLY AFTER the
      // cursor row in (backlogRank, id) order (replicates Prisma `cursor/skip:1`).
      const cursorSql = cursor
        ? Prisma.sql`AND (w."backlogRank", w."id") > (
            SELECT c."backlogRank", c."id" FROM "work_item" c WHERE c."id" = ${cursor}
          )`
        : Prisma.empty;
      const idRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT w."id"
          FROM "work_item" w
          WHERE w."sprintId" = ${sprintId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            ${cursorSql}
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})
          ORDER BY w."backlogRank" ASC, w."id" ASC
          LIMIT ${take + 1}`;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await client.workItem.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // `findMany({ id: { in } })` does not preserve id-list order — restore the
      // raw query's (backlogRank, id) seek order + window.
      return ids.map((id) => byId.get(id)).filter((r): r is WorkItem => r !== undefined);
    }

    return client.workItem.findMany({
      where: { sprintId, workspaceId, archivedAt: null },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Count of a sprint's non-archived issues (the committed-issue count). With a
   * `filter` (Subtask 8.8.20) the count is the FILTERED total — the numerator of
   * the design's "1 of 5" sprint badge; the unfiltered "of 5" denominator is the
   * separate `/api/sprints` metadata count (`sprintsService`), which never passes
   * a filter. Omitted → the byte-for-byte 4.1.4 Prisma count.
   */
  async countSprintIssues(
    sprintId: string,
    workspaceId: string,
    filter?: { ast: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;

    // Filtered total (Subtask 8.8.20): COUNT over the SAME base predicates as
    // `findSprintIssues`'s raw read with the compiled FilterAST AND-ed in.
    if (filter && filter.ast.conditions.length > 0) {
      const rows = await client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
          FROM "work_item" w
          WHERE w."sprintId" = ${sprintId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})`;
      return rows[0]?.count ?? 0;
    }

    return client.workItem.count({ where: { sprintId, workspaceId, archivedAt: null } });
  },

  /**
   * A sprint's non-archived issues whose `status` is NOT one of
   * `excludeStatusKeys`, in `backlogRank` order (Story 4.4.3). With the
   * project's `done`-category status keys passed as the exclusion set, this is
   * the sprint's **unfinished** set — the issues `completeSprint` carries over
   * (the done issues stay on the completed sprint). An empty `excludeStatusKeys`
   * applies no status filter (every issue is "unfinished"). NOT `take`-bounded:
   * carry-over must move the WHOLE unfinished set atomically, so the caller
   * reads it inside the completion transaction; the set is bounded by the
   * sprint's own scope (a team sprint, not the unbounded backlog). `workspaceId`
   * gates the read (finding #26). The `backlogRank` order is what makes the
   * carried-over issues re-appear in the backlog in their existing order.
   */
  async findSprintIssuesExcludingStatuses(
    sprintId: string,
    workspaceId: string,
    excludeStatusKeys: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    return client.workItem.findMany({
      where: {
        sprintId,
        workspaceId,
        archivedAt: null,
        ...(excludeStatusKeys.length > 0 ? { status: { notIn: excludeStatusKeys } } : {}),
      },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Sum of `storyPoints` over a sprint's non-archived issues — the committed-
   * points baseline `startSprint` snapshots at activation (Story 4.4.2). NULL-
   * estimate issues contribute nothing, and a wholly-unestimated sprint sums to
   * `null` (Prisma's `_sum` of all-NULLs) — the service maps that to a null
   * committed baseline (graceful "—", finding #57: the data layer stays total).
   * One aggregate Prisma op; the `workspaceId` filter is the tenant gate
   * (finding #26). Reusable by Story 4.3/4.6 roll-ups; defined here on the entity
   * that owns `storyPoints`.
   */
  async sumStoryPointsForSprint(
    sprintId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal | null> {
    const client = tx ?? db;
    const result = await client.workItem.aggregate({
      where: { sprintId, workspaceId, archivedAt: null },
      _sum: { storyPoints: true },
    });
    return result._sum.storyPoints;
  },

  /**
   * One bounded, cursor-paginated page of a sprint's non-archived issues split
   * by done-category MEMBERSHIP (Story 4.4.4 — the sprint report's completed vs.
   * incomplete lists). With the project's `done`-category status keys as
   * `statusKeys`:
   *   • `include: true`  → issues whose `status` IS one of them — the COMPLETED
   *     list. An EMPTY `statusKeys` means the project has no done-category status,
   *     so NOTHING is complete: `status IN ()` matches no row (the empty-input
   *     guard the coverage gate requires a direct test for).
   *   • `include: false` → issues whose `status` is NOT one of them — the
   *     INCOMPLETE list. An EMPTY `statusKeys` applies no status filter, so EVERY
   *     issue is incomplete (mirrors `findSprintIssuesExcludingStatuses`).
   * In `backlogRank` order with the `id` tiebreak (the deterministic cursor
   * ordering `findSprintIssues` uses); takes `take + 1` so the service can detect
   * a next page. `workspaceId` gates the read (finding #26).
   */
  async findSprintIssuesByDoneMembership(
    sprintId: string,
    workspaceId: string,
    params: { statusKeys: string[]; include: boolean; take: number; cursor?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take, cursor } = params;
    return client.workItem.findMany({
      where: {
        sprintId,
        workspaceId,
        archivedAt: null,
        ...doneMembershipFilter(params.statusKeys, params.include),
      },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Count of a sprint's non-archived issues split by done-category membership
   * (Story 4.4.4) — the grouped aggregate behind the report's completed /
   * incomplete COUNTS (never a loaded-page sum). Same `statusKeys` + `include`
   * semantics (and the same empty-`statusKeys` edge cases) as
   * `findSprintIssuesByDoneMembership`. One Prisma `count`; `workspaceId` gates it.
   */
  async countSprintIssuesByDoneMembership(
    sprintId: string,
    workspaceId: string,
    params: { statusKeys: string[]; include: boolean },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.workItem.count({
      where: {
        sprintId,
        workspaceId,
        archivedAt: null,
        ...doneMembershipFilter(params.statusKeys, params.include),
      },
    });
  },

  /**
   * The `backlogRank` of each requested issue (the neighbour ranks `rankIssue`
   * needs when the client drops a card between two explicit neighbours). One
   * Prisma op; `workspaceId` gates the read; an empty id list short-circuits to
   * `[]` (the empty-input guard the coverage gate requires a direct test for).
   * Returns the id + rank only — the service picks the prev/next ranks and feeds
   * them to `positioning.ts` `keyBetween`.
   */
  async findBacklogRankByIds(
    itemIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; backlogRank: string | null }>> {
    if (itemIds.length === 0) return [];
    const client = tx ?? db;
    return client.workItem.findMany({
      where: { id: { in: itemIds }, workspaceId },
      select: { id: true, backlogRank: true },
    });
  },

  /**
   * The boundary `backlogRank` of a rank scope — the FIRST (`edge: 'min'`) or
   * LAST (`edge: 'max'`) non-archived issue's rank in either the backlog
   * (`sprintId = null`) or a sprint (`sprintId` set). Powers the degenerate
   * prepend (`min`) / append (`max`) cases of `rankIssue` when there is no
   * explicit neighbour on one side. One Prisma op (a single ordered row);
   * `workspaceId` gates the read. Returns `null` when the scope is empty (the
   * first issue placed — the service seeds an initial key).
   */
  async findBoundaryBacklogRank(
    projectId: string,
    workspaceId: string,
    sprintId: string | null,
    edge: 'min' | 'max',
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const client = tx ?? db;
    const row = await client.workItem.findFirst({
      where: { projectId, workspaceId, sprintId, archivedAt: null },
      orderBy: { backlogRank: edge === 'min' ? 'asc' : 'desc' },
      select: { backlogRank: true },
    });
    return row?.backlogRank ?? null;
  },
};

/**
 * The `status` `where` fragment for a done-category MEMBERSHIP split (Story
 * 4.4.4). `include` selects the COMPLETED side (`status IN keys`), `!include`
 * the INCOMPLETE side (`status NOT IN keys`). The empty-`statusKeys` edges are
 * deliberate and asymmetric: an `include` over `[]` yields `status: { in: [] }`
 * (matches nothing — when a project has no done-category status, nothing is
 * complete), while an exclude over `[]` returns `{}` (no filter — every issue is
 * incomplete), mirroring `findSprintIssuesExcludingStatuses`.
 */
function doneMembershipFilter(statusKeys: string[], include: boolean): Prisma.WorkItemWhereInput {
  if (include) return { status: { in: statusKeys } };
  return statusKeys.length > 0 ? { status: { notIn: statusKeys } } : {};
}

// --- Prisma/Postgres error → typed error translation (repository edge) ------

/**
 * Translate a write-path error into a typed work-items error. Trigger
 * rejections arrive (via the pg driver adapter) as an error whose `cause.code`
 * is SQLSTATE 23514 and whose message carries one of the WI_* markers; we key
 * on the marker (unique strings we control) and confirm via the SQLSTATE.
 * P2002 → key conflict; P2025 → not found. Anything else is rethrown
 * unchanged. Always throws — return type is `never`.
 */
/**
 * Escape the LIKE/ILIKE metacharacters (`\`, `%`, `_`) in a user-supplied
 * substring so `findProjectForest`'s text filter matches them LITERALLY — a
 * search for "50%" finds the literal "50%", not "50<anything>". The value is
 * still passed as a bound parameter (never string-interpolated), so this guards
 * pattern semantics, not injection. Backslash is the default ILIKE ESCAPE.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The shared, multi-select filter shape the project reads accept — the tree
 * forest (`findProjectForest`) and the flat List (`findProjectIssuesFlat`).
 * Each faceted axis is a SET: `kinds` / `statuses` / `assigneeIds` match "any
 * of", AND-ed across facets (Jira's basic filters; the 2.5.4 filter bar). The
 * assignee facet is the UNION of `assigneeIds` (specific members) with
 * `includeUnassigned` (items with a null `assigneeId`). Callers pass only the
 * non-empty axes (an empty facet is omitted, not an empty array). `text` is a
 * single substring.
 */
export interface RepoIssueFilter {
  kinds?: WorkItemKind[];
  /** The work-item TYPE facet (the 6.15 quick-filter facet) — "any of" these
   * `WorkItemType` members, UNION-ed with `includeUntyped` (a null `type`).
   * `type` is nullable, so the union COALESCEs to a clean boolean exactly like
   * the assignee facet. */
  types?: WorkItemType[];
  /** Include items with a null `type` (the "Untyped" bucket), OR-ed with `types`. */
  includeUntyped?: boolean;
  statuses?: string[];
  assigneeIds?: string[];
  includeUnassigned?: boolean;
  text?: string;
  /**
   * Sprint scope (Story 4.5.2) — restrict to issues in this sprint. Used by the
   * scrum board's `countProjectIssues` (the per-column `totalCount` + the
   * truncation denominator + the epic catch-all), which scans the full
   * `work_item` table (alias `w`, all columns available). The forest read
   * (`findProjectForest`, alias `f`) projects a fixed column set that does NOT
   * include `sprintId`, so it MUST NOT be passed this axis — its callers (the
   * issue tree) never do.
   */
  sprintId?: string;
  /**
   * The advanced filter builder's compiled axis (Story 6.1 · 6.1.1) — a
   * validated {@link FilterAst}, AND-ed with the facet axes above (the facet
   * shape REMAINS as the degenerate all-AND quick path; this is the
   * superseding rich shape). Compiled over the full `work_item` row (alias
   * `w`) by {@link compileFilterConditionsSql}; the forest read satisfies
   * that by joining `work_item` back onto the CTE for the `matched` flag (the
   * CTE's fixed projection lacks `sprintId` / `createdAt` / `descriptionMd`).
   */
  ast?: FilterAst;
  /**
   * The per-project referent set the AST's Epic-5 conditions (labels /
   * components / `cf:<fieldId>` custom fields, Subtask 6.1.2) resolve
   * against — loaded by the SERVICE from bounded reads over the ids the
   * filter references. Omitted (or missing an id) ⇒ those conditions are
   * STALE referents and compile to match-nothing `FALSE` (the deleted-id
   * degrade rule, never an error). Built-in-only ASTs don't need it.
   */
  filterReferents?: ProjectFilterReferents;
  /**
   * The epic-privacy public exclusion (Story 6.14 · Subtask 6.14.4) — a hard
   * row-exclusion set (the descendants of a private epic) applied by the flat
   * COUNT read {@link workItemRepository.countProjectIssues} so a non-member's
   * board denominators never count a hidden subtree. Resolved by {@link
   * workItemRepository.findPublicHiddenDescendantIds}. Honored ONLY as a real
   * filter by `countProjectIssues`; it is deliberately NOT emitted by {@link
   * buildIssueFilterSql} (whose output is the forest read's `matched` SELECT
   * FLAG, not a WHERE filter — emitting it there would mis-flag rather than
   * exclude). Absent/empty ⇒ no-op (members + the no-private-epic case read the
   * unchanged projection).
   */
  excludeIds?: readonly string[];
}

/**
 * The optional advanced-filter axis for the BOARD reads (Story 6.15.2) — a
 * compiled {@link FilterAst} (+ the per-project Epic-5 {@link
 * ProjectFilterReferents} its label/component/custom-field conditions resolve
 * against) AND-ed into the board's card read + lane aggregates so a filtered
 * board shows ONLY matching cards (and the cap/`truncated`/lane counts are
 * computed over that filtered set). The board reads take it positionally rather
 * than through {@link RepoIssueFilter} because they already thread `statusKeys`
 * / `sprintId` positionally; the service resolves the same `{ ast, referents }`
 * it passes to `countProjectIssues` via `RepoIssueFilter`.
 */
export interface BoardCardFilter {
  ast?: FilterAst;
  referents?: ProjectFilterReferents;
}

/** The board filter as a `Prisma.Sql` predicate over alias `w`: the compiled
 * FilterAST when one is active, else `TRUE` (so an absent filter is a no-op and
 * the board read stays byte-for-byte the unfiltered projection). */
function boardCardFilterSql(filter?: BoardCardFilter): Prisma.Sql {
  return filter?.ast && filter.ast.conditions.length > 0
    ? Prisma.sql`(${compileFilterConditionsSql(filter.ast, filter.referents)})`
    : Prisma.sql`TRUE`;
}

// ---------------------------------------------------------------------------
// The FilterAST compiler (Subtask 6.1.1) — AST → parameterized WHERE fragment
// ---------------------------------------------------------------------------

/**
 * Fixed column references for the registered built-in fields, over the full
 * `work_item` alias `w`. Field/operator ids NEVER reach SQL text — they
 * resolve through this map (and the operator switch below) to fixed literals;
 * every user VALUE binds as a `Prisma.sql` parameter. Enum columns cast
 * `::text` so bound text arrays compare text-to-text (the
 * `buildIssueFilterSql` convention).
 */
const FILTER_FIELD_COLUMN_SQL: Record<Exclude<BuiltInFilterFieldId, 'text'>, Prisma.Sql> = {
  kind: Prisma.sql`w."kind"::text`,
  status: Prisma.sql`w."status"`,
  priority: Prisma.sql`w."priority"::text`,
  type: Prisma.sql`w."type"::text`,
  assignee: Prisma.sql`w."assigneeId"`,
  reporter: Prisma.sql`w."reporterId"`,
  sprint: Prisma.sql`w."sprintId"`,
  created: Prisma.sql`w."createdAt"`,
  updated: Prisma.sql`w."updatedAt"`,
  due: Prisma.sql`w."dueDate"`,
  storyPoints: Prisma.sql`w."storyPoints"`,
  estimate: Prisma.sql`w."estimateMinutes"`,
};

/**
 * Enum-list membership — `col = ANY(values)` OR-ed with `IS NULL` when the
 * list carries the field's empty-bucket sentinel ("Unassigned" / "Backlog"),
 * COALESCE-d to a clean boolean (NULL-safe three-valued logic, the
 * buildIssueFilterSql assignee precedent). `is_none_of` is its negation —
 * which, on a nullable column WITHOUT the sentinel in the list, includes the
 * empty bucket (an unassigned issue is assigned to "none of" any member
 * list), and excludes it when the sentinel IS listed.
 */
function enumListSql(
  column: Prisma.Sql,
  values: string[],
  sentinel: string | undefined,
  negate: boolean,
): Prisma.Sql {
  const includeEmpty = sentinel !== undefined && values.includes(sentinel);
  const ids = sentinel === undefined ? values : values.filter((v) => v !== sentinel);
  const terms: Prisma.Sql[] = [];
  if (ids.length > 0) terms.push(Prisma.sql`${column} = ANY(${ids})`);
  if (includeEmpty) terms.push(Prisma.sql`${column} IS NULL`);
  /* istanbul ignore next -- defensive: validation requires ≥1 value, so terms is never empty */
  if (terms.length === 0) return Prisma.sql`FALSE`;
  const membership = Prisma.sql`COALESCE((${Prisma.join(terms, ' OR ')}), FALSE)`;
  return negate ? Prisma.sql`NOT (${membership})` : membership;
}

/** The free-text contains-match — title OR description (the story's scope),
 * pattern-escaped, ILIKE backed by the pg_trgm GIN index this subtask's
 * migration adds (finding #57). The positive form stays a PLAIN two-arm OR:
 * wrapping the nullable-description arm in COALESCE defeats the index
 * (BitmapOr needs directly-indexable clauses), and WHERE treats the NULL it
 * can yield as unmatched anyway; the projection site that needs a clean
 * boolean (the forest's `matched` column) COALESCEs the WHOLE fragment. The
 * negation keeps the inner COALESCE — `NOT` must not turn a NULL description
 * into a dropped row, and a NOT-ILIKE can't use the index regardless. */
function textMatchSql(value: string, negate: boolean): Prisma.Sql {
  const pattern = `%${escapeLikePattern(value.trim())}%`;
  if (negate) {
    return Prisma.sql`NOT (w."title" ILIKE ${pattern} OR COALESCE(w."descriptionMd" ILIKE ${pattern}, FALSE))`;
  }
  return Prisma.sql`(w."title" ILIKE ${pattern} OR w."descriptionMd" ILIKE ${pattern})`;
}

const NUMBER_COMPARE_SQL: Record<'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte', Prisma.Sql> = {
  eq: Prisma.sql`=`,
  ne: Prisma.sql`<>`,
  lt: Prisma.sql`<`,
  lte: Prisma.sql`<=`,
  gt: Prisma.sql`>`,
  gte: Prisma.sql`>=`,
};

// ---------------------------------------------------------------------------
// The Epic-5 condition compilers (Subtask 6.1.2) — the documented join
// contracts: `work_item_label` / `work_item_component` EXISTS probes (5.4.1)
// and the typed-EAV `custom_field_value` probes over the four
// `[fieldId, value*]` indexes (5.3.1). Each condition is a self-contained
// correlated subquery with its own alias scope, so any number of conditions
// compose under either combinator with no join collision (bounded by the
// 20-row cap). Table/column names are fixed literals selected by enum
// switches — only VALUES bind as parameters.
// ---------------------------------------------------------------------------

const JOIN_LIST_SQL = {
  lbl: {
    table: Prisma.sql`"work_item_label"`,
    idColumn: Prisma.sql`"label_id"`,
  },
  cmp: {
    table: Prisma.sql`"work_item_component"`,
    idColumn: Prisma.sql`"component_id"`,
  },
} as const;

/**
 * A label/component condition → the 5.4.1 EXISTS probe. `is_any_of` walks the
 * reverse-edge index (`[labelId]` / `[componentId]`); `is_none_of` is its
 * NOT-EXISTS (which — join rows being absent — includes the no-labels bucket,
 * the enum none-of rule); `is empty` = no join rows at all.
 */
function joinListConditionSql(entity: 'lbl' | 'cmp', condition: FilterCondition): Prisma.Sql {
  const { table, idColumn } = JOIN_LIST_SQL[entity];
  switch (condition.operator) {
    case 'is_any_of':
    case 'is_none_of': {
      const ids = condition.value as string[];
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM ${table} j WHERE j."work_item_id" = w."id" AND j.${idColumn} = ANY(${ids}))`;
      return condition.operator === 'is_none_of' ? Prisma.sql`NOT ${exists}` : exists;
    }
    case 'is_empty':
      return Prisma.sql`NOT EXISTS (SELECT 1 FROM ${table} j WHERE j."work_item_id" = w."id")`;
    case 'is_not_empty':
      return Prisma.sql`EXISTS (SELECT 1 FROM ${table} j WHERE j."work_item_id" = w."id")`;
    /* istanbul ignore next -- defensive: resolveFilterAst pins lbl/cmp to the enum operator set before this switch */
    default:
      throw new UnknownFilterOperatorError(condition.field, condition.operator);
  }
}

/** The typed value column a custom field's conditions probe (the 5.3.1
 * `[fieldId, value*]` index family), per field type. */
const CF_VALUE_COLUMN_SQL: Record<CustomFieldFilterType, Prisma.Sql> = {
  text: Prisma.sql`v."value_text"`,
  number: Prisma.sql`v."value_number"`,
  date: Prisma.sql`v."value_date"`,
  select: Prisma.sql`v."value_option_id"`,
  user: Prisma.sql`v."value_user_id"`,
};

/** The correlated probe: does this issue carry a value row for the field
 * satisfying `valuePredicate`? The `[fieldId, value*]` composite indexes
 * serve the (field_id, value) pair; the `[workItemId, fieldId]` unique
 * serves the correlation. */
function cfExistsSql(fieldId: string, valuePredicate: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "custom_field_value" v WHERE v."work_item_id" = w."id" AND v."field_id" = ${fieldId} AND ${valuePredicate})`;
}

/**
 * A `cf:<fieldId>` condition → its typed-EAV probe (the 5.3.1 contract).
 * Empty == no value row (clearing DELETES the row — no tombstones), so
 * `is empty` compiles to NOT EXISTS; the `IS NOT NULL` arm additionally
 * covers the one nullable-in-place case (a deleted user SetNulls
 * `value_user_id`, leaving the row behind). The negative value operators
 * keep the JQL `!=`/`!~` rule the built-ins pin: `ne`/`not_contains`
 * require a value row (empties don't match — `is empty` is the explicit
 * operator), while `is_none_of`'s NOT-EXISTS includes the empty bucket
 * (the enum none-of rule).
 */
function customFieldConditionSql(
  condition: FilterCondition,
  cf: { id: string; fieldType: CustomFieldFilterType },
): Prisma.Sql {
  const column = CF_VALUE_COLUMN_SQL[cf.fieldType];
  const { operator, value } = condition;
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      const exists = cfExistsSql(cf.id, Prisma.sql`${column} = ANY(${value as string[]})`);
      return operator === 'is_none_of' ? Prisma.sql`NOT ${exists}` : exists;
    }
    case 'is_empty':
      return Prisma.sql`NOT ${cfExistsSql(cf.id, Prisma.sql`${column} IS NOT NULL`)}`;
    case 'is_not_empty':
      return cfExistsSql(cf.id, Prisma.sql`${column} IS NOT NULL`);
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return cfExistsSql(
        cf.id,
        Prisma.sql`${column} ${NUMBER_COMPARE_SQL[operator]} ${value as number}`,
      );
    case 'contains':
    case 'not_contains': {
      const pattern = `%${escapeLikePattern((value as string).trim())}%`;
      return operator === 'contains'
        ? cfExistsSql(cf.id, Prisma.sql`${column} ILIKE ${pattern}`)
        : cfExistsSql(cf.id, Prisma.sql`NOT (${column} ILIKE ${pattern})`);
    }
    case 'on_or_before':
      return cfExistsSql(cf.id, Prisma.sql`${column} <= (${value as string})::date`);
    case 'on_or_after':
      return cfExistsSql(cf.id, Prisma.sql`${column} >= (${value as string})::date`);
    case 'between': {
      const [from, to] = value as [string, string];
      return cfExistsSql(cf.id, Prisma.sql`${column} BETWEEN (${from})::date AND (${to})::date`);
    }
    case 'in_last_days':
      return cfExistsSql(
        cf.id,
        Prisma.sql`${column} >= CURRENT_DATE - (${value as number})::int AND ${column} <= CURRENT_DATE`,
      );
    case 'in_next_days':
      return cfExistsSql(
        cf.id,
        Prisma.sql`${column} >= CURRENT_DATE AND ${column} <= CURRENT_DATE + (${value as number})::int`,
      );
  }
}

/** One resolved condition → its parenthesized predicate fragment. */
function compileConditionSql(condition: FilterCondition, def: FilterFieldDef): Prisma.Sql {
  if (def.customField) return customFieldConditionSql(condition, def.customField);
  if (def.id === 'lbl' || def.id === 'cmp') return joinListConditionSql(def.id, condition);
  const { field, operator, value } = condition;
  if (field === 'text') {
    // Validation pinned the text ops + a string value.
    return textMatchSql(value as string, operator === 'not_contains');
  }
  const column = FILTER_FIELD_COLUMN_SQL[field as Exclude<BuiltInFilterFieldId, 'text'>];
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      return enumListSql(column, value as string[], def.emptySentinel, operator === 'is_none_of');
    }
    case 'is_empty':
      return Prisma.sql`${column} IS NULL`;
    case 'is_not_empty':
      return Prisma.sql`${column} IS NOT NULL`;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      // `ne` deliberately excludes the empty bucket (NULL <> v is NULL →
      // unmatched) — the documented JQL `!=` rule the registry mirrors.
      return Prisma.sql`${column} ${NUMBER_COMPARE_SQL[operator]} ${value as number}`;
    case 'on_or_before':
      return Prisma.sql`${column}::date <= (${value as string})::date`;
    case 'on_or_after':
      return Prisma.sql`${column}::date >= (${value as string})::date`;
    case 'between': {
      const [from, to] = value as [string, string];
      return Prisma.sql`${column}::date BETWEEN (${from})::date AND (${to})::date`;
    }
    case 'in_last_days':
      return Prisma.sql`${column}::date >= CURRENT_DATE - (${value as number})::int AND ${column}::date <= CURRENT_DATE`;
    case 'in_next_days':
      return Prisma.sql`${column}::date >= CURRENT_DATE AND ${column}::date <= CURRENT_DATE + (${value as number})::int`;
    /* istanbul ignore next -- defensive: validateFilterAst rejects text ops on non-text fields before this switch */
    case 'contains':
    case 'not_contains':
      throw new UnknownFilterOperatorError(field, operator);
  }
}

/**
 * Compile a FilterAST into one parameterized predicate over the `work_item`
 * alias `w` (Subtask 6.1.1; Epic-5 conditions 6.1.2). Re-resolves against the
 * registry + the referents first (defence in depth — typed 422s, mistake #29:
 * no unvalidated AST can reach SQL even through a future second caller), then
 * joins the per-condition fragments under the AND/OR combinator. A STALE
 * condition (a deleted field/option/label/component referent — including the
 * no-referents default, under which every Epic-5 condition is stale) compiles
 * to `FALSE`: it matches nothing under either combinator, never errors, and
 * none of its input reaches SQL at all. An empty row set compiles to `TRUE`
 * (match all). Exported for the injection/operator test matrix.
 */
export function compileFilterConditionsSql(
  ast: FilterAst,
  referents?: ProjectFilterReferents,
): Prisma.Sql {
  const resolved = resolveFilterAst(ast, referents);
  if (resolved.conditions.length === 0) return Prisma.sql`TRUE`;
  const fragments = resolved.conditions.map((rc) =>
    rc.stale !== null || rc.def === null
      ? Prisma.sql`(FALSE)`
      : Prisma.sql`(${compileConditionSql(rc.condition, rc.def)})`,
  );
  return Prisma.join(fragments, ast.combinator === 'or' ? ' OR ' : ' AND ');
}

// ---------------------------------------------------------------------------
// The distribution group-by fragments (Story 6.3 · Subtask 6.3.2)
// ---------------------------------------------------------------------------

/**
 * Map a TOTAL `DistributionGroupBy` descriptor to its fixed SQL fragments —
 * the id/label projections and the (LEFT) joins they read through. Table and
 * column names are FIXED LITERALS selected by the closed switches below
 * (the `FILTER_FIELD_COLUMN_SQL` rule — descriptor ids never reach SQL
 * text); the only bound value is the custom-field id. LEFT joins everywhere
 * so the empty bucket (no assignee / no sprint / no label / no value row)
 * groups under NULL — the designed "None" segment. The label/component join
 * rides the 5.4.1 reverse-edge indexes; the custom-field probe rides the
 * 5.3.1 `[workItemId, fieldId]` unique.
 */
/** The `column`-strategy fragments — `work_item` scalars, labelled through
 * their referent table where one exists. Status keys label through the
 * project's `workflow_status` rows (one project per scope — saved filters
 * are project-contained); enum columns (kind/priority) self-describe, the
 * UI translates. */
function columnGroupBySql(
  column: 'kind' | 'status' | 'priority' | 'assignee' | 'reporter' | 'sprint',
): { idExpr: Prisma.Sql; labelExpr: Prisma.Sql; joinSql: Prisma.Sql } {
  switch (column) {
    case 'kind':
      return {
        idExpr: Prisma.sql`w."kind"::text`,
        labelExpr: Prisma.sql`NULL::text`,
        joinSql: Prisma.empty,
      };
    case 'priority':
      return {
        idExpr: Prisma.sql`w."priority"::text`,
        labelExpr: Prisma.sql`NULL::text`,
        joinSql: Prisma.empty,
      };
    case 'status':
      return {
        idExpr: Prisma.sql`w."status"`,
        labelExpr: Prisma.sql`st."label"`,
        joinSql: Prisma.sql`LEFT JOIN "workflow_status" st ON st."project_id" = w."projectId" AND st."key" = w."status"`,
      };
    case 'assignee':
      return {
        idExpr: Prisma.sql`w."assigneeId"`,
        labelExpr: Prisma.sql`au."name"`,
        joinSql: Prisma.sql`LEFT JOIN "user" au ON au."id" = w."assigneeId"`,
      };
    case 'reporter':
      return {
        idExpr: Prisma.sql`w."reporterId"`,
        labelExpr: Prisma.sql`ru."name"`,
        joinSql: Prisma.sql`LEFT JOIN "user" ru ON ru."id" = w."reporterId"`,
      };
    case 'sprint':
      return {
        idExpr: Prisma.sql`w."sprintId"`,
        labelExpr: Prisma.sql`sp."name"`,
        joinSql: Prisma.sql`LEFT JOIN "sprint" sp ON sp."id" = w."sprintId"`,
      };
  }
}

function distributionGroupBySql(groupBy: DistributionGroupBy): {
  idExpr: Prisma.Sql;
  labelExpr: Prisma.Sql;
  joinSql: Prisma.Sql;
} {
  switch (groupBy.kind) {
    case 'column':
      return columnGroupBySql(groupBy.column);
    case 'join':
      return groupBy.entity === 'label'
        ? {
            idExpr: Prisma.sql`l."id"`,
            labelExpr: Prisma.sql`l."name"`,
            joinSql: Prisma.sql`LEFT JOIN "work_item_label" jl ON jl."work_item_id" = w."id" LEFT JOIN "label" l ON l."id" = jl."label_id"`,
          }
        : {
            idExpr: Prisma.sql`c."id"`,
            labelExpr: Prisma.sql`c."name"`,
            joinSql: Prisma.sql`LEFT JOIN "work_item_component" jc ON jc."work_item_id" = w."id" LEFT JOIN "component" c ON c."id" = jc."component_id"`,
          };
    case 'customField':
      return groupBy.fieldType === 'select'
        ? {
            idExpr: Prisma.sql`v."value_option_id"`,
            labelExpr: Prisma.sql`o."label"`,
            joinSql: Prisma.sql`LEFT JOIN "custom_field_value" v ON v."work_item_id" = w."id" AND v."field_id" = ${groupBy.fieldId} LEFT JOIN "custom_field_option" o ON o."id" = v."value_option_id"`,
          }
        : {
            idExpr: Prisma.sql`v."value_user_id"`,
            labelExpr: Prisma.sql`vu."name"`,
            joinSql: Prisma.sql`LEFT JOIN "custom_field_value" v ON v."work_item_id" = w."id" AND v."field_id" = ${groupBy.fieldId} LEFT JOIN "user" vu ON vu."id" = v."value_user_id"`,
          };
  }
}

/**
 * The single, total "not in triage" exclusion (Subtask 6.11.3, per
 * docs/decisions/triage-model.md §2). A submission is born a `work_item`
 * carrying a `triagedAt` marker that hides it from EVERY normal read until it
 * graduates (accept/promote clear the marker); decline/merge KEEP the marker so
 * a parentless cancelled submission can never resurface as a tree root (ADR §5).
 * So "is this item part of the planned workspace?" reduces to this one
 * predicate — `triagedAt IS NULL` — with no status/`cancelled` special-casing.
 *
 * Defined ONCE here and ANDed into every normal read OUTSIDE any user-supplied
 * FilterAST (so no filter can opt back in to triage items): the tree forest +
 * lazy tree level (+ their counts), the flat List (+ count), each board column
 * + every swimlane lane aggregate, the ready set, quick search, and the report
 * aggregates. The triage-queue read (`findTriageQueue`) is the ONLY read that
 * inverts it. The `alias` is a fixed internal literal (never user input), as in
 * `buildIssueFilterSql`. The Prisma-builder reads (`findColumnCards`, the lane
 * `groupBy`s) express the same predicate as `{ triagedAt: null }`.
 */
function notInTriageSql(alias: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(alias)}."triagedAt" IS NULL`;
}

/**
 * The sprint-scope predicate for the per-level roadmap read (MOTIR-1381). The
 * roadmap is a HIERARCHY shown one level at a time, but sprint membership is a
 * FLAT `work_item.sprintId` — epics/stories carry no `sprintId` (only the leaves
 * a sprint commits to do), so a naive `sprintId = ?` filter would empty the ROOT
 * level (no epic is a member) and break drill-down. Instead a node is in scope
 * iff it is ITSELF a sprint member OR an ANCESTOR of one: a recursive CTE seeds
 * on every in-sprint item (non-archived, not-in-triage, same project+workspace)
 * and walks UP the `parentId` edge, so the id set is `members ∪ all-ancestors`.
 * The level read ANDs `<alias>."id" IN (that set)`; with no `sprintId` it returns
 * `TRUE` (the whole-project read, byte-for-byte unchanged). The `alias` is a
 * fixed internal literal (`w` for the row, `ch` for the hasChildren probe),
 * never user input. The same `projectId`+`workspaceId` tenant gate (finding #26)
 * is repeated inside the CTE seed so the scope set can never cross tenants.
 */
function inSprintScopeSql(
  alias: 'w' | 'ch',
  projectId: string,
  workspaceId: string,
  sprintId: string | null | undefined,
): Prisma.Sql {
  if (!sprintId) return Prisma.sql`TRUE`;
  return Prisma.sql`${Prisma.raw(alias)}."id" IN (
    WITH RECURSIVE in_sprint_scope AS (
      SELECT m."id", m."parentId"
        FROM "work_item" m
        WHERE m."projectId" = ${projectId}
          AND m."workspaceId" = ${workspaceId}
          AND m."archivedAt" IS NULL
          AND ${notInTriageSql('m')}
          AND m."sprintId" = ${sprintId}
      UNION
      SELECT p."id", p."parentId"
        FROM "work_item" p
        JOIN in_sprint_scope sc ON p."id" = sc."parentId"
    )
    SELECT s."id" FROM in_sprint_scope s
  )`;
}

/**
 * The epic-privacy exclusion predicate for the PUBLIC reads (Story 6.14 ·
 * Subtask 6.14.4) — drop the rows whose ids are in `excludeIds` (the descendants
 * of a private epic, resolved once by {@link workItemRepository.findPublicHiddenDescendantIds}).
 * An EMPTY / absent set returns `TRUE`, so a member viewer (or a project with no
 * private epic) reads byte-for-byte the prior projection — the predicate is a
 * pure no-op unless a non-member is reading a public project that actually has a
 * private epic. `<> ALL(array)` binds the id set as ONE Postgres array param
 * (never interpolated), mirroring the `= ANY(...)` convention; the `alias` is a
 * fixed internal literal, not user input.
 */
function notExcludedSql(
  alias: 'w' | 'f' | 'ch',
  excludeIds: readonly string[] | undefined,
): Prisma.Sql {
  if (!excludeIds || excludeIds.length === 0) return Prisma.sql`TRUE`;
  return Prisma.sql`${Prisma.raw(alias)}."id" <> ALL(${excludeIds as string[]})`;
}

/**
 * The shared filter predicate for the project reads — the tree forest
 * (`findProjectForest`, alias `f`) and the flat List (`findProjectIssuesFlat`,
 * alias `w`). Each axis is a bound-param `Prisma.Sql` fragment (values are
 * never interpolated — multi-value axes bind as a single array via `= ANY(...)`;
 * the `alias` is a fixed internal literal, not user input). The assignee facet
 * OR-s `assigneeId = ANY(ids)` with an `IS NULL` test for `includeUnassigned`;
 * a blank `text` is ignored by callers before this point. No axis → `TRUE`
 * (match all).
 */
function buildIssueFilterSql(filter: RepoIssueFilter, alias: 'f' | 'w'): Prisma.Sql {
  const t = Prisma.raw(alias);
  const predicates: Prisma.Sql[] = [];
  if (filter.kinds && filter.kinds.length > 0) {
    // Cast the bound text[] to the enum array so `kind::text = ANY(...)` compares text-to-text.
    const kinds = filter.kinds.map((k) => k as string);
    predicates.push(Prisma.sql`${t}."kind"::text = ANY(${kinds})`);
  }
  const types = filter.types ?? [];
  if (types.length > 0 || filter.includeUntyped) {
    // The work-type facet (the 6.15 quick filter). `type` is nullable (epics /
    // stories / legacy rows are null), so — like the assignee group — OR the
    // selected types with an `IS NULL` test for the "Untyped" bucket and
    // COALESCE the whole group to a clean boolean (an unmatched null `type`
    // yields SQL NULL through `= ANY`, which must read as FALSE for the
    // projected `matched` flag, not a null DTO field).
    const terms: Prisma.Sql[] = [];
    if (types.length > 0) {
      const typeStrs = types.map((ty) => ty as string);
      terms.push(Prisma.sql`${t}."type"::text = ANY(${typeStrs})`);
    }
    if (filter.includeUntyped) terms.push(Prisma.sql`${t}."type" IS NULL`);
    predicates.push(Prisma.sql`COALESCE((${Prisma.join(terms, ' OR ')}), FALSE)`);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    predicates.push(Prisma.sql`${t}."status" = ANY(${filter.statuses})`);
  }
  if (filter.sprintId) {
    // Sprint scope (Story 4.5.2) — only the scrum-board count path sets this; it
    // scans `work_item` (alias `w`), which carries `sprintId`. (The forest read,
    // alias `f`, never sets it — see RepoIssueFilter.sprintId.)
    predicates.push(Prisma.sql`${t}."sprintId" = ${filter.sprintId}`);
  }
  const assigneeIds = filter.assigneeIds ?? [];
  if (assigneeIds.length > 0 || filter.includeUnassigned) {
    const terms: Prisma.Sql[] = [];
    // `NULL = ANY(array)` is NULL in SQL three-valued logic (assigneeId is
    // nullable), so an unassigned row would yield a NULL `matched` instead of
    // FALSE; COALESCE the whole assignee group to a clean boolean.
    if (assigneeIds.length > 0) terms.push(Prisma.sql`${t}."assigneeId" = ANY(${assigneeIds})`);
    if (filter.includeUnassigned) terms.push(Prisma.sql`${t}."assigneeId" IS NULL`);
    predicates.push(Prisma.sql`COALESCE((${Prisma.join(terms, ' OR ')}), FALSE)`);
  }
  const text = filter.text?.trim();
  if (text) {
    const pattern = `%${escapeLikePattern(text)}%`;
    predicates.push(
      Prisma.sql`(${t}."identifier" ILIKE ${pattern} OR ${t}."title" ILIKE ${pattern})`,
    );
  }
  if (filter.ast && filter.ast.conditions.length > 0) {
    // The advanced-builder axis (6.1.1). Compiled over the FULL `work_item`
    // alias `w` — callers on the fixed-projection forest alias `f` must strip
    // it and compose the fragment over a joined `w` instead (findProjectForest
    // does); reaching here with alias `f` is a programming error, not input.
    if (alias !== 'w') {
      throw new Error('RepoIssueFilter.ast requires the full work_item alias (w)');
    }
    predicates.push(
      Prisma.sql`(${compileFilterConditionsSql(filter.ast, filter.filterReferents)})`,
    );
  }
  return predicates.length ? Prisma.join(predicates, ' AND ') : Prisma.sql`TRUE`;
}

function translateWriteError(err: unknown, ctx?: { id?: string }): never {
  const message = extractMessage(err);
  const sqlState = extractSqlState(err);

  if (sqlState === '23514' || isTriggerMarker(message)) {
    if (message.includes('WI_ILLEGAL_PARENT_TYPE') || message.includes('WI_SUBTASK_NEEDS_PARENT')) {
      throw new IllegalParentTypeError(message);
    }
    if (message.includes('WI_DEPTH_LIMIT_EXCEEDED')) {
      throw new DepthLimitExceededError(message);
    }
    if (message.includes('WI_PARENT_CYCLE')) {
      throw new ParentCycleError(message);
    }
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') throw new WorkItemKeyConflictError();
    /* istanbul ignore next -- defensive default: the P2025 path is only reached via update/archive, which always pass ctx.id, so the '(unknown)' fallback is unreachable */
    if (err.code === 'P2025') throw new WorkItemNotFoundError(ctx?.id ?? '(unknown)');
  }

  /* istanbul ignore next -- defensive rethrow: every work_item write error is a 23514 trigger marker or a Prisma P2002/P2025, all handled above */
  throw err;
}

function isTriggerMarker(message: string): boolean {
  return (
    message.includes('WI_ILLEGAL_PARENT_TYPE') ||
    message.includes('WI_SUBTASK_NEEDS_PARENT') ||
    message.includes('WI_DEPTH_LIMIT_EXCEEDED') ||
    message.includes('WI_PARENT_CYCLE')
  );
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */
function extractSqlState(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: unknown; originalCode?: unknown };
      if (typeof c.code === 'string') return c.code;
      /* istanbul ignore next -- defensive: the @prisma/adapter-pg error exposes `code`; `originalCode` is a fallback for a future driver shape */
      if (typeof c.originalCode === 'string') return c.originalCode;
    }
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /* istanbul ignore next -- defensive: work_item write errors are always Error instances; these branches guard a non-Error throw */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* istanbul ignore next -- defensive: see above */
  return String(err);
}
