import { Prisma, type NotificationPreference } from '@prisma/client';
import { db } from '@/lib/db';
import type { NotificationChannel } from '@/lib/notifications/preferences';

// Notification-preference repository — single Prisma operations on the
// `notification_preference` table (Story 5.7 · Subtask 5.7.6). The persistence
// leaf the `notificationPreferencesService` reads (the settings matrix + the
// resolver gate lookups) and writes (the per-cell upsert). The SERVICE is the
// authority for transactions, validation, defaults, and DTO mapping; this leaf
// holds none of that.
//
// Layer rules (CLAUDE.md): the write (`upsert`) REQUIRES `tx`; pure read paths
// use the `db` singleton. No business logic, no transactions, no DTO mapping.
//
// A row exists ONLY for a cell the user has explicitly toggled — absence means
// "use the documented default" (resolved in the service/mapper), so reads never
// assume a row is present.

export interface UpsertNotificationPreferenceInput {
  userId: string;
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
}

export const notificationPreferenceRepository = {
  /** All of a user's stored preference rows (the settings-matrix read). */
  async findByUser(userId: string): Promise<NotificationPreference[]> {
    return db.notificationPreference.findMany({ where: { userId } });
  },

  /**
   * One stored cell, or null when unset (the single-recipient gate lookup —
   * 5.7.3's `isChannelEnabled`). Null ⇒ the caller applies the default.
   */
  async findOne(
    userId: string,
    eventType: string,
    channel: NotificationChannel,
  ): Promise<NotificationPreference | null> {
    return db.notificationPreference.findUnique({
      where: { userId_eventType_channel: { userId, eventType, channel } },
    });
  },

  /**
   * The stored rows for MANY users on ONE (event-type, channel) — the batch
   * the email fan-out gate reads in a single query instead of N round-trips
   * (5.1.6 enqueues a recipient batch). Empty-input guard: no users → no DB
   * round-trip, return `[]`.
   */
  async findByUsersForChannel(
    userIds: string[],
    eventType: string,
    channel: NotificationChannel,
  ): Promise<NotificationPreference[]> {
    if (userIds.length === 0) return [];
    return db.notificationPreference.findMany({
      where: { userId: { in: userIds }, eventType, channel },
    });
  },

  /**
   * Set ONE (user, event-type, channel) cell — insert on first toggle, update
   * thereafter (keyed on the `@@unique`). Required `tx` (rides the service
   * transaction). Idempotent by construction: re-applying the same value is a
   * no-op update.
   */
  async upsert(
    input: UpsertNotificationPreferenceInput,
    tx: Prisma.TransactionClient,
  ): Promise<NotificationPreference> {
    const { userId, eventType, channel, enabled } = input;
    return tx.notificationPreference.upsert({
      where: { userId_eventType_channel: { userId, eventType, channel } },
      create: { userId, eventType, channel, enabled },
      update: { enabled },
    });
  },
};
