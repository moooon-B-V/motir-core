import { Prisma, type Watcher } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import {
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TODO,
  HOME_SLICE_UNFINISHED,
  HOME_KIND_SORT_ORDER,
  HOME_WORK_ITEM_SELECT,
  homeProjectScopeWhere,
  type HomeProjectScope,
  type HomeWorkItemRow,
  type WatchingGroup,
} from '@/lib/repositories/workItemRepository';

// Watcher repository — single Prisma operations on the `watcher` table
// (Story 5.4 · Subtask 5.4.1). The persistence leaf under watchersService
// (5.4.4), which owns the verified permission split (anyone with view
// watches THEMSELVES; project admin + workspace admin/owner manage others),
// the view-access validation (typed rejection, never Jira's silent drop),
// the auto-watch hooks (create + comment, inside their owning
// transactions), and DTO mapping. Watch paths write NO work_item_revision
// rows (mirror: watching is not a field change).

/**
 * A watcher row with its user riding along — the watchers-popover shape
 * (Avatar · name). One query, no N+1.
 */
export type WatcherWithUser = Prisma.WatcherGetPayload<{ include: { user: true } }>;

export const watcherRepository = {
  /**
   * Add one watcher, idempotently: an upsert against the
   * `@@unique([workItemId, userId])` key, so re-watching (and the
   * auto-watch hooks firing on an already-watching user) is a no-op — "the
   * unique absorbs it" (5.4.4), with no P2002 to catch. One Prisma op.
   * Required `tx`: the auto-watch hooks ride `createWorkItem`'s /
   * `addComment`'s transactions.
   */
  async add(workItemId: string, userId: string, tx: Prisma.TransactionClient): Promise<Watcher> {
    return tx.watcher.upsert({
      where: { workItemId_userId: { workItemId, userId } },
      create: { workItemId, userId },
      update: {},
    });
  },

  /**
   * Remove one watcher. `deleteMany` so unwatching while not watching is an
   * idempotent 0-count, not a P2025 throw. Returns the deleted count.
   */
  async remove(workItemId: string, userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.watcher.deleteMany({ where: { workItemId, userId } });
    return r.count;
  },

  /**
   * One PAGE of an issue's watchers, each carrying its user (the popover's
   * Avatar · name rows, and the 5.4.5 notification job's paged fan-out — a
   * 200-watcher issue never builds an unbounded batch, finding #57).
   * Oldest-first (stable roster order), `id` as the tie-breaking secondary
   * sort (PRODECT_FINDINGS #38 — `createdAt` alone is not a total order),
   * cursor resuming strictly after the previous page's last row. Walks the
   * `[workItemId, userId]` unique's left-prefix. Read-only path → `db`
   * singleton.
   */
  async listByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WatcherWithUser[]> {
    const client = tx ?? dbRead;
    const { take = 20, cursor } = options;
    return client.watcher.findMany({
      where: { workItemId },
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * One PAGE of the items a USER watches, within a workspace — the Workbench's
   * Watching tab (Story MOTIR-2649 · MOTIR-2651, re-ordered by MOTIR-4781).
   * The read this repository did not have: every method above answers a
   * question about ONE item's roster; this one answers "what am I watching",
   * which is the axis `model Watcher`'s `@@index([userId])` was added for (its
   * own comment says so: *"the issues I watch read path"*).
   *
   * Projects the SAME {@link HomeWorkItemRow} the work reads return, through the
   * `workItem` relation, so the tabs cannot drift into different columns.
   *
   * ⚠️ WHAT IS MOVING SITS ABOVE WHAT IS WAITING — an ORDER, not a filter
   * (MOTIR-4781). Membership is untouched and nothing is dropped: every
   * `in_progress`-category row comes back ahead of every `todo`-category one,
   * with the existing `(updatedAt DESC, id DESC)` keyset ordering WITHIN each
   * group exactly as it did before.
   *
   * ⚠️ IT IS TWO QUERIES, AND THAT IS THE POINT RATHER THAN A SHORTCUT.
   * Postgres would express this as `ORDER BY (status = ANY($1)) DESC, …`, and
   * Prisma has no way to order by a computed expression — `orderBy` reaches
   * scalars and relation scalars only. The three alternatives were all worse:
   * ordering by `status` sorts the keys ALPHABETICALLY (a silent wrong answer
   * that looks grouped in the default workflow, where `in_progress` happens to
   * precede `todo`); re-ordering in the SERVICE only groups WITHIN a page, so
   * the boundary drifts the moment a reader pages; and dropping to `$queryRaw`
   * would hand-write the projection this file shares with the work reads
   * precisely so the two cannot diverge. So the groups are read in sequence,
   * each with its own keyset, and the CURSOR records which group it stopped in
   * — which is what makes the order stable ACROSS a page boundary and not
   * merely within one.
   *
   * `projectScopes` is the actor's BROWSABLE set, passed IN by `homeService` for
   * the same reason as the work reads: filtering after the query shortens pages
   * instead of erroring. An empty set short-circuits. Each scope carries its
   * project's own status keys grouped by category ({@link HomeProjectScope}),
   * which is both what defines the two groups and what keeps finished work out
   * — an item you watch that has shipped is not waiting on you either, its
   * notification already fired through the bell, and leaving it in would keep
   * this tab's badge reading the graveyard (MOTIR-2758).
   *
   * ⚠️ Watching is NOT a partition of the work tabs. An item the reader owns AND
   * watches is returned by both reads, deliberately — they answer different
   * questions about the same item.
   *
   * ⚠️ `tx` is REQUIRED even though this is a read, for the same reason
   * `quickLinkRepository`'s reads are: `work_item` is RLS-gated on
   * `app.workspace_id`, and that GUC is bound by `withWorkspaceContext`'s
   * transaction — so the same call through the `db` singleton would run with an
   * unset GUC and, under the non-bypass runtime role, return NOTHING. An
   * optional `tx` here is an invitation to write a read that silently yields an
   * empty list in production and passes every test, since tests connect as the
   * superuser and bypass RLS. `take` is required for a duller reason: the page
   * size is `homeService`'s to decide (`HOME_PAGE_SIZE`), and a second default
   * here would be a number nobody reads.
   */
  async listByUserInGroup(
    userId: string,
    workspaceId: string,
    options: {
      projectScopes: readonly HomeProjectScope[];
      /** WHICH of the two bands this call reads. The band is a PREDICATE, not a sort key. */
      group: WatchingGroup;
      take: number;
      /** How many rows of THIS GROUP to skip — the service splits the page's offset. */
      skip?: number;
    },
    tx: Prisma.TransactionClient,
  ): Promise<HomeWorkItemRow[]> {
    const { projectScopes, group, take, skip = 0 } = options;
    if (projectScopes.length === 0 || take <= 0) return [];
    const rows = await tx.watcher.findMany({
      where: {
        userId,
        workItem: {
          workspaceId,
          archivedAt: null,
          triagedAt: null, // read-exclusion (6.11.3), same as every list read
          // ⚠️ The fragment carries an `OR`, so it goes in an explicit `AND` — a
          // spread would have it overwrite anything else `OR`-bearing here. (It
          // shared this `AND` with the keyset until MOTIR-4852 retired it.)
          AND: [
            homeProjectScopeWhere(
              projectScopes,
              group === 'in_progress' ? HOME_SLICE_IN_PROGRESS : HOME_SLICE_TODO,
            ),
          ],
        },
      },
      select: { workItem: { select: HOME_WORK_ITEM_SELECT } },
      // The SAME order the work tabs use, one level down the relation: the kind
      // rank derived from `READY_KIND_RANK`, then the total `id` tiebreak that
      // makes an offset boundary exact.
      orderBy: [{ workItem: { kind: HOME_KIND_SORT_ORDER } }, { workItem: { id: 'desc' } }],
      skip,
      take,
    });
    return rows.map((r) => r.workItem);
  },

  /**
   * How many watched items are in ONE of the two groups — what
   * `homeService.listWatching` needs to split a page's offset between them.
   *
   * ⚠️ It is the SAME predicate {@link listByUserInGroup} lists with, minus the
   * window: that is the whole reason this exists rather than the service
   * counting rows it fetched. A count that can drift from its list is the shape
   * MOTIR-2758 was filed about.
   */
  async countByUserInGroup(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    group: WatchingGroup,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (projectScopes.length === 0) return 0;
    return tx.watcher.count({
      where: {
        userId,
        workItem: {
          workspaceId,
          archivedAt: null,
          triagedAt: null,
          AND: [
            homeProjectScopeWhere(
              projectScopes,
              group === 'in_progress' ? HOME_SLICE_IN_PROGRESS : HOME_SLICE_TODO,
            ),
          ],
        },
      },
    });
  },

  /**
   * How many items the Watching read would return — the tab's count badge
   * (Subtask MOTIR-2653). Same predicate as {@link listByUserInGroup} minus the
   * keyset, so the number beside the tab is the number the tab will show.
   * Required `tx` for the same RLS reason as {@link listByUserInGroup}.
   */
  async countByUser(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (projectScopes.length === 0) return 0;
    return tx.watcher.count({
      where: {
        userId,
        workItem: {
          workspaceId,
          archivedAt: null,
          triagedAt: null,
          // The `AND` form even though the keyset is absent here: the twin above
          // needs it, and a count that is one refactor away from disagreeing
          // with its list is the defect this card fixed.
          AND: [homeProjectScopeWhere(projectScopes, HOME_SLICE_UNFINISHED)],
        },
      },
    });
  },

  /**
   * Is this user watching this issue? The detail read's
   * `viewerIsWatching` flag (5.4.4 slots it into `getIssueDetail`'s
   * parallel fetch). Point lookup on the compound unique.
   */
  async existsFor(
    workItemId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? dbRead;
    const row = await client.watcher.findUnique({
      where: { workItemId_userId: { workItemId, userId } },
      select: { id: true },
    });
    return row !== null;
  },

  /**
   * How many watchers an issue has — the header eye-count (`watcherCount`
   * on the detail read) and the popover's paging denominator.
   */
  async countByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.watcher.count({ where: { workItemId } });
  },
};
