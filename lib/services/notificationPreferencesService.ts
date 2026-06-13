import { db } from '@/lib/db';
import { notificationPreferenceRepository } from '@/lib/repositories/notificationPreferenceRepository';
import {
  defaultChannelEnabled,
  findNotificationEventTypeMeta,
  isNotificationChannel,
  type NotificationChannel,
} from '@/lib/notifications/preferences';
import {
  NotificationEventTypeNotSettableError,
  UnknownNotificationChannelError,
  UnknownNotificationEventTypeError,
} from '@/lib/notifications/preferenceErrors';
import {
  toNotificationPreferenceCellDto,
  toNotificationPreferenceMatrixDto,
} from '@/lib/mappers/notificationPreferenceMappers';
import type {
  NotificationPreferenceCellDto,
  NotificationPreferenceMatrixDto,
} from '@/lib/dto/notificationPreferences';

// Per-user notification preferences (Story 5.7 · Subtask 5.7.6) — the business
// logic behind the Jira *Personal settings → Notification settings* surface AND
// the single CHANNEL GATE both notification channels honour.
//
// The resolver (`isChannelEnabled` / `filterChannelEnabled`) is the load-bearing
// seam: the SAME code is consulted by
//   * the 5.7.3 in-app fan-in job (the `in_app` channel — its permissive stub
//     is replaced by this resolver when 5.7.3 lands), AND
//   * the DONE 5.1.6 email job (the `email` channel — wired at its SEND
//     decision in mentionNotificationsService, touching no emit site).
// Toggling a channel off therefore suppresses THAT channel for THAT event type,
// while the event still fires once (the one-emit-path invariant holds).
//
// DEFAULTS: an unset cell resolves to the documented default (direct/mention
// events ON), supplied by the resolver — an unset row is NOT "off". So an
// untouched user has zero rows and still behaves correctly.
//
// 4-layer: this SERVICE owns validation, the write transaction, and DTO
// mapping; the repository is the single-op leaf. Every method is scoped to one
// user id (preferences are personal, cross-workspace — the design's "these
// apply to you across every workspace").

export const notificationPreferencesService = {
  /**
   * The full preferences matrix for the settings page — every modelled
   * (event-type × channel) cell resolved (stored value or default), including
   * the disabled Story 5.4 seam row. Read-only (no `tx`).
   */
  async getMatrix(userId: string): Promise<NotificationPreferenceMatrixDto> {
    const rows = await notificationPreferenceRepository.findByUser(userId);
    return toNotificationPreferenceMatrixDto(rows);
  },

  /**
   * Toggle ONE (event-type, channel) cell for a user. Validates the channel and
   * that the event type is SETTABLE (the disabled Story 5.4 seam is rejected),
   * then upserts in a single transaction. Returns the resolved cell so the UI
   * updates from the RESPONSE (no tree re-fetch — the inline-edit contract).
   */
  async setPreference(
    userId: string,
    input: { eventType: string; channel: string; enabled: boolean },
  ): Promise<NotificationPreferenceCellDto> {
    const { eventType, channel, enabled } = input;
    if (!isNotificationChannel(channel)) throw new UnknownNotificationChannelError(channel);
    const meta = findNotificationEventTypeMeta(eventType);
    if (!meta) throw new UnknownNotificationEventTypeError(eventType);
    if (!meta.settable) throw new NotificationEventTypeNotSettableError(eventType);

    const row = await db.$transaction((tx) =>
      notificationPreferenceRepository.upsert({ userId, eventType, channel, enabled }, tx),
    );
    return toNotificationPreferenceCellDto(row);
  },

  /**
   * The single-recipient gate (the 5.7.3 in-app job's call site). True iff this
   * user wants `channel` for `eventType` — the stored value, or the documented
   * default when unset. Read-only.
   */
  async isChannelEnabled(
    userId: string,
    eventType: string,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const row = await notificationPreferenceRepository.findOne(userId, eventType, channel);
    return row ? row.enabled : defaultChannelEnabled(eventType, channel);
  },

  /**
   * The BATCH gate (the email fan-out's send decision — 5.1.6 enqueues a
   * recipient batch). Returns the subset of `userIds` for whom `channel` is
   * enabled for `eventType` (stored value, or the default when unset), in the
   * input order, in ONE query. Empty input → `[]`.
   */
  async filterChannelEnabled(
    userIds: string[],
    eventType: string,
    channel: NotificationChannel,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await notificationPreferenceRepository.findByUsersForChannel(
      userIds,
      eventType,
      channel,
    );
    const stored = new Map(rows.map((r) => [r.userId, r.enabled]));
    const fallback = defaultChannelEnabled(eventType, channel);
    return userIds.filter((id) => stored.get(id) ?? fallback);
  },
};
