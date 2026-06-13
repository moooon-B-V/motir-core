import type { NotificationPreference } from '@prisma/client';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PREFERENCE_EVENT_TYPES,
  defaultChannelEnabled,
  type NotificationChannel,
} from '@/lib/notifications/preferences';
import type {
  NotificationPreferenceCellDto,
  NotificationPreferenceMatrixDto,
} from '@/lib/dto/notificationPreferences';

// Prisma → DTO converters for notification preferences (Story 5.7 · 5.7.6).

/** The composite key into the stored-row lookup. */
function cellKey(eventType: string, channel: string): string {
  return `${eventType}:${channel}`;
}

/**
 * Resolve the full matrix from a user's STORED rows: every modelled
 * (event-type × channel) cell is the stored value when a row exists, else the
 * documented default — so an untouched user (zero rows) still renders "direct
 * events on" without any DB row. The matrix shape (rows/order/settable) is the
 * domain constant, NOT the stored rows, so the disabled Story 5.4 seam always
 * appears even though it is never persisted.
 */
export function toNotificationPreferenceMatrixDto(
  rows: NotificationPreference[],
): NotificationPreferenceMatrixDto {
  const stored = new Map<string, boolean>();
  for (const row of rows) stored.set(cellKey(row.eventType, row.channel), row.enabled);

  const resolve = (eventType: string, channel: NotificationChannel): boolean =>
    stored.get(cellKey(eventType, channel)) ?? defaultChannelEnabled(eventType, channel);

  const events = NOTIFICATION_PREFERENCE_EVENT_TYPES.map((meta) => ({
    eventType: meta.type,
    settable: meta.settable,
    channels: {
      email: resolve(meta.type, 'email'),
      in_app: resolve(meta.type, 'in_app'),
    },
  }));

  return { channels: [...NOTIFICATION_CHANNELS], events };
}

/** One persisted row → the cell DTO a toggle PUT returns. */
export function toNotificationPreferenceCellDto(
  row: NotificationPreference,
): NotificationPreferenceCellDto {
  return { eventType: row.eventType, channel: row.channel, enabled: row.enabled };
}
