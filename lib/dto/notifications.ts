import type { NotificationCategory } from '@prisma/client';

// Wire DTOs for the notifications domain (Story 5.7 · Subtask 5.7.4). The
// service maps Prisma rows to these via lib/mappers/notificationMappers.ts
// just before returning (CLAUDE.md — services never return raw Prisma
// models). Dates are ISO strings, matching the comments / work-items DTO
// convention.

/** The actor who caused a notification, as the feed row renders it (Avatar ·
 * name). Null when the notification has no actor (a system event) OR when the
 * actor user has since been deleted — the `actor` relation is
 * `onDelete: SetNull` (5.7.2), so "no actor" is a renderable state, not a bug. */
export interface NotificationActorDTO {
  id: string;
  name: string;
  image: string | null;
}

/**
 * The denormalized render payload captured at FAN-IN time (5.7.3 writes it;
 * 5.7.4 surfaces it) so the feed read is a single-table scan — no join storm
 * per row (Story 5.7 description; the 5.7.2 `data Json` column). Every field is
 * optional because the shape grows with the event types that fan in: 5.1.6's
 * `mentioned` / `commented` carry `issueKey` + `title` (+ a comment `excerpt`),
 * 5.4's `transitioned` adds `fromStatus` / `toStatus`, 6.6's events add their
 * own — all via the registry seam, with no change to this reader. The client
 * (5.7.5) composes the human sentence ("**Zhu Yue** mentioned you on
 * **PROD-42: …**") from `type` + actor + these nouns.
 */
export interface NotificationData {
  /** The deep-link target's issue key (e.g. `PROD-42`) — the row click target. */
  issueKey?: string;
  /** The work item's title, for the summary line. */
  title?: string;
  /** A plain-text comment excerpt (mention tokens already rendered as @Name). */
  excerpt?: string;
  /** Status transition nouns (the 5.4 `transitioned` fan-in slot). */
  fromStatus?: string;
  toStatus?: string;
}

export interface NotificationDTO {
  id: string;
  /** The event-type discriminator (`mentioned` | `commented` | `assigned` |
   * `transitioned` | …) — the axis the 5.7.6 preference matrix keys on and the
   * client renders the summary verb from. */
  type: string;
  /** The drawer tab this row belongs to — `direct` (mentions / assignment /
   * reporter) vs `watching` (the 5.4 fan-in slot). */
  category: NotificationCategory;
  /** Who caused it (the row avatar), or null (system / deleted actor). */
  actor: NotificationActorDTO | null;
  /** The deep-link work item id, or null for a non-item notification. */
  workItemId: string | null;
  /** The denormalized nouns the row renders from (no per-row join). */
  data: NotificationData;
  /** Set on mark-read — drives the blue-dot (unread) vs greyed (read) treatment.
   * Null = unread. */
  readAt: string | null;
  createdAt: string;
}

/**
 * One cursor-paged window of a recipient's feed (finding #57 — never a
 * load-all). `unreadCount` is the cheap partial-index aggregate the bell badge
 * reads; `totalCount` is every notification matching the current filter (the
 * drawer's "N notifications"); `nextCursor` is the id to resume AFTER for the
 * next (older) page, or null on the last page.
 */
export interface NotificationsPageDTO {
  notifications: NotificationDTO[];
  totalCount: number;
  unreadCount: number;
  nextCursor: string | null;
}

/** The bell-badge poll payload — just the cheap unread aggregate. */
export interface UnreadCountDTO {
  unreadCount: number;
}

/**
 * The mark-read mutation result. Carries the freshly-updated row AND the new
 * `unreadCount` so the caller updates the badge + row from the RESPONSE, never
 * a tree re-fetch (the inline-edit-no-whole-tree-refresh contract).
 */
export interface MarkReadResultDTO {
  notification: NotificationDTO;
  unreadCount: number;
}

/** The mark-all-read result — the new `unreadCount` (zero) for the same reason. */
export interface MarkAllReadResultDTO {
  unreadCount: number;
}
