// Wire DTOs for the watchers domain (Story 5.4 · Subtask 5.4.4). The service
// maps Prisma rows to these via lib/mappers/watcherMappers.ts just before
// returning (CLAUDE.md — services never return raw Prisma models).

/** One watcher as the popover renders it (Avatar · name). */
export interface WatcherDto {
  /** The WATCHING USER's id (what add/remove target) — not the join-row id. */
  userId: string;
  name: string;
  image: string | null;
}

/**
 * One cursor-paged window of an issue's watchers (finding #57 — never a
 * load-all). `canManage` tells the popover whether to render the admin-only
 * add/remove affordances (the "Manage watchers" tier).
 */
export interface WatchersPageDto {
  watchers: WatcherDto[];
  /** Every watcher of the issue — the header eye-count denominator. */
  totalCount: number;
  /** Pass back to resume strictly after this page; null on the last page. */
  nextCursor: string | null;
  /** May the CALLER add/remove other people (project admin / ws owner-admin)? */
  canManage: boolean;
}

/** The self watch/unwatch result — the eye control's optimistic reconcile. */
export interface WatchStateDto {
  watching: boolean;
  watcherCount: number;
}
