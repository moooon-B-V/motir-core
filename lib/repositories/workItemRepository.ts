import { Prisma, type WorkItem, type WorkItemKind, type WorkItemPriority } from '@prisma/client';
import { db } from '@/lib/db';
import type { IssueSort, IssueSortColumn } from '@/lib/issues/issueListView';
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
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  dueDate: Date | null;
  estimateMinutes: number | null;
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
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  dueDate: Date | null;
  estimateMinutes: number | null;
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
  priority: Prisma.sql`w."priority"`,
  assignee: Prisma.sql`au."name"`,
  reporter: Prisma.sql`ru."name"`,
  due: Prisma.sql`w."dueDate"`,
  estimate: Prisma.sql`w."estimateMinutes"`,
  status: Prisma.sql`ws."position"`,
};

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
   * Candidate work items for the link picker (Subtask 2.4.9): non-archived
   * items in the WORKSPACE (cross-project — the link model allows cross-project
   * links), excluding `excludeIds` (the current item + the ones already linked
   * by the chosen relationship). Bounded to `limit` newest-first; the picker's
   * Combobox filters this set by identifier/title client-side (full server
   * search is Epic 6). Explicit `workspaceId` gate — the primary tenant filter
   * (finding #26; RLS is inert under the dev/CI superuser). Read-only → `db`.
   */
  async findLinkCandidates(
    workspaceId: string,
    excludeIds: string[],
    limit: number,
  ): Promise<WorkItem[]> {
    return db.workItem.findMany({
      where: { workspaceId, archivedAt: null, id: { notIn: excludeIds } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
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
      where: { projectId, workspaceId, kind: { in: [...kinds] }, archivedAt: null },
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
    options: { take?: number; cursor?: string } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take = 50, cursor } = options;
    return client.workItem.findMany({
      where: { projectId, archivedAt: null },
      orderBy: { key: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
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
      where: { parentId, archivedAt: null },
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
   * The WHOLE non-archived issue forest of a project, in ONE round-trip via a
   * recursive CTE walking DOWN the `parentId` edge from the roots
   * (`parentId IS NULL`). Each row carries its `depth` (root = 1, for the
   * tree-table's indentation) and the lighter render columns (no Markdown
   * blobs). Backs `workItemsService.getProjectTree` (Subtask 2.5.1) — the read
   * behind the `/issues` list view.
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
    // The filter axes, as a bound-param predicate over the forest alias `f`
    // (shared with the flat List read — see buildIssueFilterSql).
    const matched = buildIssueFilterSql(filter, 'f');

    return client.$queryRaw<WorkItemForestRow[]>`
      WITH RECURSIVE forest AS (
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."priority", w."assigneeId", w."reporterId",
               w."dueDate", w."estimateMinutes", 1 AS depth
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."parentId" IS NULL
            AND w."archivedAt" IS NULL
        UNION ALL
        SELECT c."id", c."parentId", c."kind", c."key", c."identifier",
               c."title", c."status", c."priority", c."assigneeId", c."reporterId",
               c."dueDate", c."estimateMinutes", p.depth + 1
          FROM "work_item" c
          JOIN forest p ON c."parentId" = p."id"
          WHERE c."projectId" = ${projectId}
            AND c."workspaceId" = ${workspaceId}
            AND c."archivedAt" IS NULL
      )
      SELECT f."id",
             f."parentId",
             f."kind"::text       AS "kind",
             f."key",
             f."identifier",
             f."title",
             f."status",
             f."priority"::text   AS "priority",
             f."assigneeId",
             f."reporterId",
             f."dueDate",
             f."estimateMinutes",
             f.depth::int         AS "depth",
             (${matched})         AS "matched"
        FROM forest f
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
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemListRow[]> {
    const client = tx ?? db;
    const matched = buildIssueFilterSql(filter, 'w');
    const orderCol = ISSUE_SORT_SQL[sort.column];
    const dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

    return client.$queryRaw<WorkItemListRow[]>`
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
             w."estimateMinutes"
        FROM "work_item" w
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        LEFT JOIN "user" ru ON ru."id" = w."reporterId"
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND (${matched})
        ORDER BY ${orderCol} ${dir} NULLS LAST, w."key" ASC`;
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
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemTreeRow[]> {
    const client = tx ?? db;
    const orderCol = ISSUE_SORT_SQL[sort.column];
    const dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;

    return client.$queryRaw<WorkItemTreeRow[]>`
      SELECT w."id",
             w."parentId",
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
             EXISTS (
               SELECT 1 FROM "work_item" ch
                WHERE ch."parentId" = w."id" AND ch."archivedAt" IS NULL
             )                    AS "hasChildren"
        FROM "work_item" w
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        LEFT JOIN "user" ru ON ru."id" = w."reporterId"
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
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
};

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
  statuses?: string[];
  assigneeIds?: string[];
  includeUnassigned?: boolean;
  text?: string;
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
  if (filter.statuses && filter.statuses.length > 0) {
    predicates.push(Prisma.sql`${t}."status" = ANY(${filter.statuses})`);
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
