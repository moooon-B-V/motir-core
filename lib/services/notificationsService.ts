import type { NotificationCategory, Prisma, User } from '@prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { toNotificationDto } from '@/lib/mappers/notificationMappers';
import { NotificationNotFoundError } from '@/lib/notifications/errors';
import type {
  MarkAllReadResultDTO,
  MarkReadResultDTO,
  NotificationsPageDTO,
  UnreadByCategoryDTO,
  UnreadCountDTO,
} from '@/lib/dto/notifications';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Notifications service (Story 5.7 · Subtask 5.7.4) — the READ + mark-state
// API the bell/drawer (5.7.5) calls, over the 5.7.2 repository. Owns the
// per-user scoping, paging, transactions, DTO mapping, and typed errors. Routes
// are HTTP-only (CLAUDE.md).
//
// Two scoping gates, both enforced here:
//   * WORKSPACE — every method runs inside `withWorkspaceContext`, which binds
//     the `app.workspace_id` GUC the `notification` RLS policy reads (5.7.2's
//     deliberate design: "workspace = RLS, recipient = app filter"). Under the
//     production non-bypass `prodect_app` role the policy narrows reads to the
//     active workspace; the bell is a per-workspace surface (Jira's per-site /
//     Linear's per-workspace inbox).
//   * RECIPIENT — every read/mutate filters/gates on `recipientUserId ===
//     ctx.userId`. A notification belongs to exactly ONE recipient; another
//     user's row (or one in another workspace) reads as 404 — never 403, never
//     leaking that it exists (finding #44). So the only typed error is
//     NotificationNotFoundError.
//
// Inline-edit contract (the inline-edit-no-whole-tree-refresh memory): the
// mark-read / mark-all-read mutations RETURN the fresh `unreadCount` (and the
// updated row) so the caller updates the badge + row from the RESPONSE, never a
// tree re-fetch. The bell/drawer (5.7.5) trusts its own success — no
// `router.refresh()` / `revalidatePath` fan-out (that fan-out is what caused
// the revert bug the memory records).
//
// Scale (finding #57): the feed read is cursor-paged (take 20 + "Show more"),
// the unread count is the 5.7.2 partial-index aggregate, mark-all is one bulk
// UPDATE — never a load-all or a per-row client loop (the JRACLOUD-85017
// anti-pattern).

/** The drawer's page size — the newest window the feed renders (finding #57). */
export const NOTIFICATION_PAGE_SIZE = 20;

export interface ListNotificationsOptions {
  /** Resume strictly AFTER this notification id (the previous page's last row). */
  cursor?: string;
  /** Narrow to one drawer tab (`direct` | `watching`); omitted = both. */
  category?: NotificationCategory;
}

/**
 * Resolve the actor users a page of notifications references, batched into ONE
 * read (no N+1). Returns a Map for the mapper; missing actors (deleted →
 * SetNull, or a null actorId) simply have no entry and render as "no actor".
 */
async function resolveActors(
  actorIds: (string | null)[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, User>> {
  const ids = [...new Set(actorIds.filter((id): id is string => id !== null))];
  const actors = await userRepository.findByIds(ids, tx);
  return new Map(actors.map((u) => [u.id, u]));
}

/**
 * The per-drawer-tab unread breakdown (bug 8.8.1) — one category-scoped unread
 * count per tab, both index-backed (the partial `notification_unread_idx`),
 * read in parallel. The GLOBAL `unreadCount` the bell badge shows is the SUM of
 * these (the `NotificationCategory` enum is exactly `direct | watching`), so the
 * drawer reports the sum to the bell while each tab badge reads its own entry.
 */
async function unreadByCategory(
  recipientUserId: string,
  tx: Prisma.TransactionClient,
): Promise<UnreadByCategoryDTO> {
  const [direct, watching] = await Promise.all([
    notificationRepository.countUnreadByRecipient(recipientUserId, { category: 'direct' }, tx),
    notificationRepository.countUnreadByRecipient(recipientUserId, { category: 'watching' }, tx),
  ]);
  return { direct, watching };
}

/** Global unread total = the sum of the per-tab breakdown (the bell badge). */
function totalUnread(byCategory: UnreadByCategoryDTO): number {
  return byCategory.direct + byCategory.watching;
}

export const notificationsService = {
  /**
   * One cursor-paged window of the caller's feed (take 20), with the total +
   * unread counts and the next-page cursor. Scoped to `ctx.userId`; optionally
   * narrowed to one drawer tab. NEVER a load-all (finding #57): a take+1 probe
   * decides `nextCursor` without a second round-trip, and the two counts come
   * from cheap aggregates (the unread one index-backed).
   */
  async listNotifications(
    options: ListNotificationsOptions,
    ctx: ServiceContext,
  ): Promise<NotificationsPageDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      // take+1 probes for a next page without a second read.
      const window = await notificationRepository.listByRecipient(
        ctx.userId,
        { take: NOTIFICATION_PAGE_SIZE + 1, cursor: options.cursor, category: options.category },
        tx,
      );
      const rows = window.slice(0, NOTIFICATION_PAGE_SIZE);
      const hasMore = window.length > NOTIFICATION_PAGE_SIZE;

      const [actorsById, totalCount, byCategory] = await Promise.all([
        resolveActors(
          rows.map((r) => r.actorId),
          tx,
        ),
        notificationRepository.countByRecipient(ctx.userId, { category: options.category }, tx),
        unreadByCategory(ctx.userId, tx),
      ]);

      return {
        notifications: rows.map((row) => toNotificationDto(row, actorsById)),
        totalCount,
        unreadCount: totalUnread(byCategory),
        unreadByCategory: byCategory,
        nextCursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
      };
    });
  },

  /**
   * The bell-badge aggregate — the cheap partial-index unread count for the
   * active workspace + caller. A single fast query (the badge poll calls it on
   * an interval), never a row fetch.
   */
  async getUnreadCount(ctx: ServiceContext): Promise<UnreadCountDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      const unreadCount = await notificationRepository.countUnreadByRecipient(ctx.userId, {}, tx);
      return { unreadCount };
    });
  },

  /**
   * Mark ONE notification the caller owns read. Idempotent — an already-read
   * row is a no-op (its `readAt` is left untouched). Returns the updated row +
   * the fresh `unreadCount` so the caller updates the badge from the RESPONSE
   * (the inline-edit contract). A row that doesn't exist, belongs to another
   * user, or lives in another workspace reads as 404 (finding #44).
   */
  async markRead(notificationId: string, ctx: ServiceContext): Promise<MarkReadResultDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      const existing = await notificationRepository.findById(notificationId, tx);
      if (
        !existing ||
        existing.recipientUserId !== ctx.userId ||
        existing.workspaceId !== ctx.workspaceId
      ) {
        throw new NotificationNotFoundError(notificationId);
      }

      const row =
        existing.readAt === null
          ? await notificationRepository.markRead(notificationId, new Date(), tx)
          : existing;

      const [actorsById, byCategory] = await Promise.all([
        resolveActors([row.actorId], tx),
        unreadByCategory(ctx.userId, tx),
      ]);

      return {
        notification: toNotificationDto(row, actorsById),
        unreadCount: totalUnread(byCategory),
        unreadByCategory: byCategory,
      };
    });
  },

  /**
   * Mark ALL of the caller's unread notifications read in ONE bulk statement
   * (the "Mark all as read" action — the 5.7.2 `updateMany`, not a per-row
   * client loop). Returns the new `unreadCount` (zero) for the same
   * update-from-the-response reason.
   */
  async markAllRead(ctx: ServiceContext): Promise<MarkAllReadResultDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      await notificationRepository.markAllReadByRecipient(ctx.userId, new Date(), tx);
      const byCategory = await unreadByCategory(ctx.userId, tx);
      return { unreadCount: totalUnread(byCategory), unreadByCategory: byCategory };
    });
  },
};
