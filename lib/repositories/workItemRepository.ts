import {
  Prisma,
  type EstimationStatistic,
  type WorkItem,
  type WorkItemKind,
  type WorkItemPriority,
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
    const escaped = escapeLikePattern(query);
    const prefixPattern = `${escaped}%`;
    const containsPattern = `%${escaped}%`;
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
          ${excludeSql}
          AND (
            w."identifier" ILIKE ${prefixPattern}
            OR w."title" ILIKE ${containsPattern}
          )
        ORDER BY
          CASE
            WHEN LOWER(w."identifier") = ${exact} THEN 0
            WHEN w."identifier" ILIKE ${prefixPattern} THEN 1
            ELSE 2
          END ASC,
          w."key" ASC,
          w."identifier" ASC
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
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."priority", w."assigneeId", w."reporterId",
               w."dueDate", w."estimateMinutes", w."storyPoints", w."updatedAt", 1 AS depth
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."parentId" IS NULL
            AND w."archivedAt" IS NULL
        UNION ALL
        SELECT c."id", c."parentId", c."kind", c."key", c."identifier",
               c."title", c."status", c."priority", c."assigneeId", c."reporterId",
               c."dueDate", c."estimateMinutes", c."storyPoints", c."updatedAt", p.depth + 1
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
          AND (${matched})`;
    return rows[0]?.count ?? 0;
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
    opts: { limit: number; updatedSince?: Date; sprintId?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (statusKeys.length === 0) return [];
    const client = tx ?? db;
    const orderBy: Prisma.WorkItemOrderByWithRelationInput[] =
      order === 'recent'
        ? [{ updatedAt: 'desc' }, { key: 'asc' }]
        : [{ position: 'asc' }, { key: 'asc' }];
    return client.workItem.findMany({
      where: {
        projectId,
        workspaceId,
        archivedAt: null,
        status: { in: statusKeys },
        ...(opts.updatedSince ? { updatedAt: { gte: opts.updatedSince } } : {}),
        // Sprint scope (Story 4.5.2) — a SCRUM board's projection passes the
        // active sprint's id so the column loads only that sprint's issues; a
        // kanban board omits it (unscoped, byte-for-byte the 3.1.4 load).
        ...(opts.sprintId ? { sprintId: opts.sprintId } : {}),
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
             w."storyPoints",
             w."updatedAt",
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
  ): Promise<Array<{ assigneeId: string | null; count: number }>> {
    if (statusKeys.length === 0) return [];
    const rows = await db.workItem.groupBy({
      by: ['assigneeId'],
      where: {
        projectId,
        workspaceId,
        archivedAt: null,
        status: { in: statusKeys },
        ...(sprintId ? { sprintId } : {}),
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({ assigneeId: r.assigneeId, count: r._count._all }));
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
  ): Promise<Array<{ priority: WorkItemPriority; count: number }>> {
    if (statusKeys.length === 0) return [];
    const rows = await db.workItem.groupBy({
      by: ['priority'],
      where: {
        projectId,
        workspaceId,
        archivedAt: null,
        status: { in: statusKeys },
        ...(sprintId ? { sprintId } : {}),
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({ priority: r.priority, count: r._count._all }));
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
  ): Promise<Array<{ epicId: string; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Sprint scope (Story 4.5.2): only the anchor (the board CARDS) is sprint-
    // filtered; the upward climb to the ancestor epic must NOT be (an epic
    // ancestor is rarely itself in the sprint). Bound param, never interpolated.
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    return db.$queryRaw<Array<{ epicId: string; count: number }>>`
      WITH RECURSIVE up AS (
        SELECT w."id" AS card_id, w."id" AS node_id, w."parentId", w."kind"::text AS kind
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."status" = ANY(${statusKeys})
            ${sprintScope}
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
        AND (${astSql})
      GROUP BY 1, 2
      ORDER BY 3 DESC, 2 ASC NULLS LAST, 1 ASC NULLS LAST`;
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
    options: { take: number; cursor?: string; excludeStatusKeys?: string[] },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take, cursor, excludeStatusKeys = [] } = options;
    return client.workItem.findMany({
      where: {
        projectId,
        workspaceId,
        sprintId: null,
        archivedAt: null,
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
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.workItem.count({
      where: {
        projectId,
        workspaceId,
        sprintId: null,
        archivedAt: null,
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
    options: { take: number; cursor?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? db;
    const { take, cursor } = options;
    return client.workItem.findMany({
      where: { sprintId, workspaceId, archivedAt: null },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /** Count of a sprint's non-archived issues (the committed-issue count). */
  async countSprintIssues(
    sprintId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
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
