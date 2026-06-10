import { Prisma, type Watcher } from '@prisma/client';
import { db } from '@/lib/db';

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
