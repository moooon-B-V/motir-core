// Activity-feed DTOs (Story 5.5 · Subtask 5.5.1) — the wire shape of the
// issue History feed. A `work_item_revision` row crosses the API boundary as
// an ActivityEntryDto: the raw machine diff ({ assigneeId: { from, to } })
// becomes a list of typed PARTS the UI renders as sentences ("changed the
// Assignee: Odie → Mo"). The service ships DATA, not prose — field keys and
// discriminated value forms — so the UI owns wording via next-intl and the
// 5.5.3 design owns the row grammar.

/**
 * One side of a change, resolved to its display form. Discriminated by
 * `type` so the UI picks the right rendering (Pill for statuses, Avatar +
 * name for users, …). A deleted referent keeps its stored id with the
 * resolved field (`label` / `name` / `identifier`) null — the UI renders its
 * fallback form ("former member", the raw key) instead of crashing; the id is
 * never dropped.
 */
export type ActivityValueDto =
  | { type: 'none' }
  | { type: 'text'; text: string }
  | { type: 'status'; key: string; label: string | null }
  | { type: 'user'; userId: string; name: string | null; image: string | null }
  | { type: 'date'; date: string }
  | { type: 'sprint'; sprintId: string; name: string | null }
  | { type: 'issue'; workItemId: string; identifier: string | null };

/**
 * One renderable piece of an activity entry. A scalar field edit is a
 * `field` part; body fields (description / explanation) are `fieldEdited` —
 * the feed says "updated the Description" and NEVER inlines the text; link
 * changes carry the link kind + the target issue; in-flight collection
 * shapes (attachments / labels / components, Stories 5.2 / 5.4) are
 * `collection` parts; a 5.1.2 comment deletion is a `commentDeleted` part
 * (who + reply count, never the content); and any diff key the registry
 * doesn't know renders as the `generic` part — the mistake-#29 fallback that
 * keeps the lookup total by construction.
 */
export type ActivityEntryPartDto =
  | { kind: 'created' }
  | { kind: 'archived' }
  | { kind: 'field'; field: string; from: ActivityValueDto; to: ActivityValueDto }
  | { kind: 'fieldEdited'; field: string }
  | { kind: 'link'; op: 'added' | 'removed'; linkKind: string; target: ActivityValueDto }
  | { kind: 'collection'; field: string; op: 'added' | 'removed'; items: string[] }
  | { kind: 'commentDeleted'; author: ActivityValueDto; replyCount: number }
  | { kind: 'generic'; key: string; from: string | null; to: string | null };

/** One history feed entry — a displayable revision, actor resolved. */
export interface ActivityEntryDto {
  /** The underlying revision id (also the page cursor). */
  id: string;
  workItemId: string;
  /**
   * The revision's audit verb. Widened to `string` (vs the closed
   * RevisionChangeKind union) on purpose: sibling stories add kinds (5.1.2's
   * `comment_deleted`), and an unknown kind must degrade to its diff-driven
   * parts, never crash the feed.
   */
  changeKind: string;
  /** ISO-8601. */
  changedAt: string;
  actor: { userId: string; name: string | null; image: string | null };
  /** Always ≥1 — a revision whose every diff key is suppressed is no entry. */
  parts: ActivityEntryPartDto[];
}

export type ActivityOrder = 'asc' | 'desc';

export interface ActivityListOptions {
  /** Resume after this revision id (the previous page's `nextCursor`). */
  cursor?: string;
  /** `desc` (newest first — the default) or `asc`. */
  order?: ActivityOrder;
}

/** One page of the History feed. */
export interface ActivityHistoryPageDto {
  entries: ActivityEntryDto[];
  /**
   * Cursor for the next page, or null when the trail is exhausted. May be
   * non-null with `entries.length < pageSize` when the bounded noise scan
   * stopped early — "Show more" just continues from it.
   */
  nextCursor: string | null;
  /** Displayable entries in the whole trail (suppressed-only rows excluded). */
  totalCount: number;
}
