// Typed errors for the notifications domain (Story 5.7 · Subtask 5.7.4). Kept
// in their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status:
//   NotificationNotFoundError → 404
//
// There is deliberately NO "forbidden" error. A notification belongs to
// exactly ONE recipient; a row that exists but is owned by another user (or
// lives in another workspace) reads as 404, never 403 — a caller must not be
// able to tell their own missing id apart from someone else's existing one
// (finding #44, no existence leak). So every per-user-scoping failure collapses
// into NotFound.

export class NotificationNotFoundError extends Error {
  readonly code = 'NOTIFICATION_NOT_FOUND' as const;
  constructor(notificationId: string) {
    super(`Notification ${notificationId} not found.`);
    this.name = 'NotificationNotFoundError';
  }
}
