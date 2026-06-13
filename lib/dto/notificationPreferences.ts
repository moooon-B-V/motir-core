import type { NotificationChannel } from '@/lib/notifications/preferences';

// DTOs for the notification-preference surface (Story 5.7 · Subtask 5.7.6) —
// the shape that crosses the API boundary to the settings matrix and back.

/** One resolved (event-type, channel) cell — the unit a toggle PUT returns so
 * the client updates the switch from the RESPONSE, not a tree re-fetch (the
 * inline-edit-no-whole-tree-refresh contract). */
export interface NotificationPreferenceCellDto {
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
}

/** Both channels resolved for one event row (explicit keys, not a `Record`, so
 * indexing by a `NotificationChannel` yields `boolean`, never `undefined`). */
export interface NotificationChannelFlags {
  email: boolean;
  in_app: boolean;
}

/** One event-type row of the matrix — both channels resolved (row value OR the
 * documented default), plus whether the row is settable (false = the disabled
 * Story 5.4 seam the matrix draws greyed with a "Soon" tag). */
export interface NotificationEventPreferenceDto {
  eventType: string;
  settable: boolean;
  channels: NotificationChannelFlags;
}

/** The whole preferences matrix the settings page renders. */
export interface NotificationPreferenceMatrixDto {
  channels: NotificationChannel[];
  events: NotificationEventPreferenceDto[];
}
