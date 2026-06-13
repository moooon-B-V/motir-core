// Typed errors for the notification-PREFERENCE domain (Story 5.7 · Subtask
// 5.7.6). Prisma-free (the lib/savedFilters/errors pattern) so routes and
// client code can import them. The route + Server-side callers translate the
// stable `code` to HTTP status via lib/notifications/preferenceErrorResponse.ts:
//   UnknownNotificationChannelError          → 422 (channel not `email`/`in_app`)
//   UnknownNotificationEventTypeError        → 422 (event type Motir does not model)
//   NotificationEventTypeNotSettableError    → 422 (a modelled-but-disabled seam,
//                                              e.g. the Story 5.4 `transitioned`
//                                              row — drawn disabled, rejected here)
//
// Kept in their own `preferenceErrors.ts` (not the shared notifications
// `errors.ts`) so this subtask never collides with the sibling 5.7.4 feed
// service that owns the feed-side errors.

export class UnknownNotificationChannelError extends Error {
  readonly code = 'UNKNOWN_NOTIFICATION_CHANNEL' as const;
  constructor(channel: string) {
    super(`Unknown notification channel "${channel}" (expected "email" or "in_app").`);
    this.name = 'UnknownNotificationChannelError';
  }
}

export class UnknownNotificationEventTypeError extends Error {
  readonly code = 'UNKNOWN_NOTIFICATION_EVENT_TYPE' as const;
  constructor(eventType: string) {
    super(`Unknown notification event type "${eventType}".`);
    this.name = 'UnknownNotificationEventTypeError';
  }
}

export class NotificationEventTypeNotSettableError extends Error {
  readonly code = 'NOTIFICATION_EVENT_TYPE_NOT_SETTABLE' as const;
  constructor(eventType: string) {
    super(`The notification event type "${eventType}" cannot be configured yet.`);
    this.name = 'NotificationEventTypeNotSettableError';
  }
}
