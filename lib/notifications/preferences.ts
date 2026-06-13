import type { $Enums } from '@prisma/client';

// Notification-preference domain constants (Story 5.7 · Subtask 5.7.6).
//
// The per-user × EVENT-TYPE × CHANNEL preference matrix is the single CHANNEL
// GATE consulted by BOTH the 5.7.3 in-app fan-in job (`in_app`) AND the DONE
// 5.1.6 email job (`email`). This module is the one source of truth for:
//   * the closed CHANNEL set;
//   * the event-type rows the settings matrix renders (and whether each is
//     SETTABLE yet — the Story 5.4 `transitioned` row is drawn disabled);
//   * the DEFAULT for an UNSET (event, channel) cell — the resolver supplies
//     it, so an untouched user has ZERO rows yet still gets the documented
//     behaviour (direct/mention events ON for both channels). An unset row is
//     NOT "off".
//
// Prisma-free of the client (only the generated `$Enums` type), so routes,
// services, AND client components can import it.

/** The closed delivery-channel set — tied to the Prisma enum so the two never
 * drift. `email` = the DONE 5.1.6 job; `in_app` = the 5.7.3 bell feed. */
export type NotificationChannel = $Enums.NotificationChannel;

export const NOTIFICATION_CHANNELS = [
  'email',
  'in_app',
] as const satisfies readonly NotificationChannel[];

/** The notification EVENT-TYPE discriminators — the SAME open axis as
 * `Notification.type` (a string, not an enum), so Story 5.4 (`transitioned`)
 * and Story 6.6 (`created` / `field.changed`) extend it with no migration. */
export const NOTIFICATION_EVENT_TYPE = {
  mentioned: 'mentioned',
  commented: 'commented',
  assigned: 'assigned',
  transitioned: 'transitioned',
} as const;

export interface NotificationPreferenceEventTypeMeta {
  /** The discriminator stored on `NotificationPreference.eventType`. */
  readonly type: string;
  /** `false` ⇒ drawn DISABLED in the matrix and REJECTED on write — a
   * documented future seam, not yet active. `transitioned` is Story 5.4's
   * (issue-watching) event: the 5.7.3 fan-in consumes it with no 5.7 change
   * when 5.4 lands, at which point this flips to `true`. */
  readonly settable: boolean;
  /** The default for an UNSET row, per channel (the resolver supplies it). */
  readonly defaults: Readonly<Record<NotificationChannel, boolean>>;
}

/** The event-type rows, in matrix display order. Direct/mention events default
 * ON for both channels (the Jira personal-notification-settings shape + the
 * design's annotated default). `transitioned` carries defaults too (so it is
 * correct the moment 5.4 flips `settable`), but is not settable today. */
export const NOTIFICATION_PREFERENCE_EVENT_TYPES: readonly NotificationPreferenceEventTypeMeta[] = [
  {
    type: NOTIFICATION_EVENT_TYPE.mentioned,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  {
    type: NOTIFICATION_EVENT_TYPE.commented,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  {
    type: NOTIFICATION_EVENT_TYPE.assigned,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  // Story 5.4 seam — drawn disabled, rejected on write, until issue-watching ships.
  {
    type: NOTIFICATION_EVENT_TYPE.transitioned,
    settable: false,
    defaults: { email: true, in_app: true },
  },
];

/** True iff `value` is one of the closed delivery channels. */
export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return value === 'email' || value === 'in_app';
}

/** The meta for an event type, or `undefined` when the type is unmodelled. */
export function findNotificationEventTypeMeta(
  eventType: string,
): NotificationPreferenceEventTypeMeta | undefined {
  return NOTIFICATION_PREFERENCE_EVENT_TYPES.find((m) => m.type === eventType);
}

/** The documented default for an UNSET (event, channel) cell. An UNMODELLED
 * event type defaults to ENABLED — the gate never silently suppresses an event
 * Motir has not yet given the user a preference for (fail-open: notify). */
export function defaultChannelEnabled(eventType: string, channel: NotificationChannel): boolean {
  return findNotificationEventTypeMeta(eventType)?.defaults[channel] ?? true;
}
