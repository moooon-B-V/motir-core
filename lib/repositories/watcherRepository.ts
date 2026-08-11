import { Prisma, type Watcher } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  HOME_WORK_ITEM_SELECT,
  homeKeysetWhere,
  type HomeCursor,
  type HomeWorkItemRow,
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
    const client = tx ?? db;
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
   * One PAGE of the items a USER watches, within a workspace — the Watching tab
   * of Home (Story MOTIR-2649 · Subtask MOTIR-2651). The read this repository
   * did not have: every method above answers a question about ONE item's
   * roster; this one answers "what am I watching", which is the axis
   * `model Watcher`'s `@@index([userId])` was added for (its own comment says
   * so: *"the issues I watch read path"*).
   *
   * Projects the SAME {@link HomeWorkItemRow} the My work read returns, through
   * the `workItem` relation, so the two tabs cannot drift into different
   * columns — and orders by the same total `(workItem.updatedAt DESC,
   * workItem.id DESC)` keyset, so both tabs page by identical rules and one
   * cursor type serves both.
   *
   * `projectIds` is the actor's BROWSABLE set, passed IN by `homeService` for
   * the same reason as the My work read: filtering after the query shortens
   * pages instead of erroring. An empty set short-circuits.
   *
   * ⚠️ Watching is NOT a partition of My work. An item the reader owns AND
   * watches is returned by both reads, deliberately — they answer different
   * questions about the same item.
   *
   * The trailing `.map` is a PROJECTION, not logic: one Prisma op, unwrapped to
   * the row shape the mapper takes. Read-only path → `db` singleton.
   */
  async listByUser(
    userId: string,
    workspaceId: string,
    options: {
      projectIds: readonly string[];
      take?: number;
      cursor?: HomeCursor | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<HomeWorkItemRow[]> {
    const { projectIds, take = 25, cursor } = options;
    if (projectIds.length === 0) return [];
    const client = tx ?? db;
    const rows = await client.watcher.findMany({
      where: {
        userId,
        workItem: {
          workspaceId,
          projectId: { in: [...projectIds] },
          archivedAt: null,
          triagedAt: null, // read-exclusion (6.11.3), same as every list read
          ...homeKeysetWhere(cursor),
        },
      },
      select: { workItem: { select: HOME_WORK_ITEM_SELECT } },
      orderBy: [{ workItem: { updatedAt: 'desc' } }, { workItem: { id: 'desc' } }],
      take,
    });
    return rows.map((r) => r.workItem);
  },

  /**
   * How many items the Watching read would return — the tab's count badge
   * (Subtask MOTIR-2653). Same predicate as {@link listByUser} minus the
   * keyset, so the number beside the tab is the number the tab will show.
   */
  async countByUser(
    userId: string,
    workspaceId: string,
    projectIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (projectIds.length === 0) return 0;
    const client = tx ?? db;
    return client.watcher.count({
      where: {
        userId,
        workItem: {
          workspaceId,
          projectId: { in: [...projectIds] },
          archivedAt: null,
          triagedAt: null,
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
    const client = tx ?? db;
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
    const client = tx ?? db;
    return client.watcher.count({ where: { workItemId } });
  },
};
