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
 * per row (Story 5.7 description; the 5.7.2 `data Json` column). The client
 * (5.7.5) composes the human sentence ("**Zhu Yue** mentioned you on
 * **PROD-42: …**") from `kind` + actor + these nouns.
 *
 * **This is the SINGLE source-of-truth contract for `Notification.data`** —
 * imported by BOTH the fan-in WRITER (`notificationFanInService`) and the read
 * MAPPER (`notificationMappers.toNotificationDto`). Subtask 5.7.9 collapsed the
 * two divergent definitions that had drifted: the writer stored
 * `workItemKey` / `workItemTitle`, this DTO declared `issueKey` / `title`, and
 * `toNotificationDto` passed `data` through with a blind `as` cast — so a
 * fanned-in row read back through the DTO exposed the producer keys verbatim and
 * `issueKey` / `title` came out `undefined`. One type now governs both ends, and
 * the mapper translates explicitly at the read boundary (no blind cast).
 *
 * A discriminated union on `kind`: the shape grows with the event types that
 * fan in via the registry seam — `mentioned` ships now (the 5.1.6 events); the
 * `transitioned` arm is the documented Story 5.4 slot (no producer yet, no
 * forward dep). `issueKey` is the deep-link target the drawer routes to
 * (`/issues/[key]`, per `design/notifications/drawer.mock.html`).
 */
export type NotificationData = NotificationMentionedData | NotificationTransitionedData;

/** A mention — the SHIPPED 5.1.6 `work-item/mentioned` + `work-item/comment.created`
 * events. `source` selects the row copy (comment body vs item description);
 * `excerpt` is the plain-text body (mention tokens already rendered as @Name),
 * `null` when empty. */
export interface NotificationMentionedData {
  kind: 'mentioned';
  source: 'comment' | 'description';
  /** The deep-link target's issue key (e.g. `PROD-42`) — the row click target. */
  issueKey: string;
  /** The work item's title, for the summary line. */
  title: string;
  /** A plain-text comment/description excerpt, or `null` when there is none. */
  excerpt: string | null;
}

/** A status transition — the Story 5.4 `work-item/transitioned` fan-in slot (a
 * documented seam; no producer yet, no forward dep on 5.4 here). */
export interface NotificationTransitionedData {
  kind: 'transitioned';
  /** The deep-link target's issue key (e.g. `PROD-42`). */
  issueKey: string;
  /** The work item's title, for the summary line. */
  title: string;
  /** Status transition nouns. */
  fromStatus: string;
  toStatus: string;
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
