// Page DTOs (Story MOTIR-5752 · MOTIR-7277) — what crosses the service boundary
// for a project's pages. `docs/decisions/pages.md` §3: the canonical body is the
// Yjs state, so the read model hands the editor THAT, and every other format is
// derived from it on the far side.

/** One page, as `pagesService.getPage` returns it. */
export interface PageDto {
  id: string;
  projectId: string;
  title: string;
  /** Advances by one on every save; the editor's staleness signal. */
  revision: number;
  /** The canonical Yjs state (`Y.encodeStateAsUpdate`), base64-encoded. */
  bodyState: string;
  /** ISO-8601. */
  updatedAt: string;
  /** Whether the caller holds `page:edit` — the editor opens writable or read-only. */
  canEdit: boolean;
}

/** A page row without its body — what a create or a rename returns. */
export interface PageSummaryDto {
  id: string;
  projectId: string;
  title: string;
  position: string;
  revision: number;
  updatedAt: string;
}

/**
 * One row of the `/pages` index (MOTIR-7300) — `pagesService.listPages`. Its own
 * shape rather than a widened {@link PageSummaryDto}: a row needs who edited the
 * page last, which no write's reply needs, and no position or revision.
 */
export interface PageListItemDto {
  id: string;
  /** The page's own title — `''` for an untitled page; the UI supplies the copy. */
  title: string;
  /** ISO-8601 — the last edit. */
  updatedAt: string;
  /** Who made that edit. `id` lets the row say "by you" to its own author. */
  updatedBy: { id: string; name: string };
}

export interface ListPagesInput {
  projectId: string;
}

/** What a save returns: the revision the update produced. */
export interface SavePageResultDto {
  revision: number;
}

export interface CreatePageInput {
  projectId: string;
  title?: string;
}

export interface GetPageInput {
  projectId: string;
  pageId: string;
}

export interface RenamePageInput {
  projectId: string;
  pageId: string;
  title: string;
}

export interface SavePageUpdateInput {
  projectId: string;
  pageId: string;
  /** A Yjs update produced against the page's state. */
  update: Uint8Array;
}

// ── History (Story MOTIR-5754 · MOTIR-7385) — `docs/decisions/pages.md` §6 ──

/** One row of a page's history — `pagesService.listPageVersions`. */
export interface PageVersionListItemDto {
  /** Per page, from 1, never reused. */
  number: number;
  authorId: string;
  /** The author's display name; `''` only if the batch read did not return them. */
  authorName: string;
  /** ISO-8601 — when this version's first save landed. */
  startedAt: string;
  /** ISO-8601 — its last save. */
  savedAt: string;
  /** The version a restore copied; `null` unless this row is a restore. */
  restoredFromNumber: number | null;
  /** Whether that source is still kept (the cap may have pruned it). `false` unless a restore. */
  restoredFromKept: boolean;
  /** Whether this is the page's newest version — its current content. */
  isCurrent: boolean;
}

/** One page of a page's history, newest first. */
export interface PageVersionListDto {
  items: PageVersionListItemDto[];
  /** Pass as `before` for the next page; `null` on the last one. */
  nextBefore: number | null;
}

/** One version with its snapshot — `pagesService.getPageVersion`. */
export interface PageVersionDto extends PageVersionListItemDto {
  /** The version's Yjs state, base64-encoded — the shape `PageDto.bodyState` uses. */
  bodyState: string;
}

/** What a restore returns: the new current state, so an open editor re-seeds without a read. */
export interface RestorePageVersionResultDto {
  revision: number;
  /** The version the restore recorded — now the current one. */
  version: PageVersionListItemDto;
  /** The page's new canonical state, base64-encoded. */
  bodyState: string;
}

export interface ListPageVersionsInput {
  projectId: string;
  pageId: string;
  /** Continue below this version number (the previous page's `nextBefore`). */
  before?: number;
  /** Page size; defaults to `PAGE_LEVEL_PAGE_SIZE`, capped at `PAGE_LEVEL_PAGE_SIZE_MAX`. */
  limit?: number;
}

export interface GetPageVersionInput {
  projectId: string;
  pageId: string;
  number: number;
}

export interface RestorePageVersionInput {
  projectId: string;
  pageId: string;
  number: number;
}
