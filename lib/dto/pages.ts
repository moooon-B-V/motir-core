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
  /**
   * Whether the caller may write THIS page — `page:edit`, and the page is live.
   * An archived page is read-only whatever the role (MOTIR-7421), so the editor
   * host mounts read-only.
   */
  canEdit: boolean;
  /**
   * Whether the caller holds `page:delete` (MOTIR-7419) — Manager only — so the
   * page can hide Delete… without a second round trip.
   */
  canDelete: boolean;
  /**
   * ISO-8601 when the page is archived (MOTIR-7420), `null` while it is live. An
   * archived page still opens at its address, read-only (§7).
   */
  archivedAt: string | null;
  /**
   * The page whose archive took this one — itself for an archive root; `null`
   * while live. A sub-page's banner links to it: only the root restores or
   * deletes (MOTIR-7421).
   */
  archiveRoot: { id: string; title: string } | null;
  /** Who archived it; `null` while live, or once that user is deleted. */
  archivedBy: { id: string; name: string } | null;
  /**
   * Whether the caller may restore THIS page — `page:edit`, and it is an archive
   * root. Reported beside `canDelete` (the permission), so a sub-page shows
   * neither action and links to its root instead.
   */
  canRestore: boolean;
}

/**
 * One row of the Archived pages list (MOTIR-7420): an archive ROOT — a sub-page
 * that left with it is not a row of its own — with how many sub-pages left with
 * it and the placement it was archived from, so the list can say where it came
 * from.
 */
export interface PageArchivedRootDto {
  id: string;
  title: string;
  /** ISO-8601. */
  archivedAt: string;
  archivedBy: { id: string; name: string } | null;
  /** The pages that left with it, itself excluded. */
  subPageCount: number;
  /** The parent it was archived from. */
  parent: PageParentDto;
  /** Its stored ancestor chain, root-first — the came-from trail's pages. */
  ancestorPageIds: string[];
}

/**
 * One Archived pages row as the service returns it (MOTIR-7421): the root, and
 * where it came from — its stored ancestor pages by title (an ancestor deleted
 * since reads as an em dash; an archived one by its own title), under the folder
 * chain its topmost page was filed in.
 */
export interface PageArchivedListItemDto extends PageArchivedRootDto {
  cameFrom: PageTrailDto;
}

/** A page of the Archived pages list, newest first. */
export interface PageArchivedListDto {
  items: PageArchivedListItemDto[];
  /** Pass back to read the next page; `null` after the last. */
  nextCursor: string | null;
}

export interface ListArchivedPagesInput {
  projectId: string;
  cursor?: string | null;
  limit?: number | null;
}

/** Archive, restore or permanently delete one page — always by its id in a project. */
export interface PageArchiveActionInput {
  projectId: string;
  pageId: string;
}

/** What an archive returns: the set that left, root first. */
export interface ArchivePageResultDto {
  archivedIds: string[];
  rootId: string;
  /** The sub-pages that left with it — the set minus the root. */
  subPageCount: number;
}

/**
 * Where a restored page landed — `original` (where it was), `ancestorPage` (the
 * nearest live ancestor), `folder` or `root` — with the parent's display name,
 * for the restored-elsewhere notice. `title` is `null` at the project root.
 */
export interface PageRestoreLandingDto {
  kind: 'original' | 'ancestorPage' | 'folder' | 'root';
  parentPageId: string | null;
  folderId: string | null;
  title: string | null;
}

export interface RestorePageResultDto {
  restoredIds: string[];
  landing: PageRestoreLandingDto;
}

export interface DeletePageResultDto {
  deletedIds: string[];
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
  /** Where the page goes; the project root when omitted (MOTIR-7370). */
  parent?: PageParentInput;
}

// ── The page tree (Story MOTIR-5753 · MOTIR-7370) ──────────────────────────

/**
 * A parent as a request names it — `@motir/pages`' `parsePlacement` input:
 * `{ kind: 'root' }`, `{ kind: 'folder', id }` or `{ kind: 'page', id }`. Typed
 * loosely ON PURPOSE: any other kind (a `work_item`) reaches the package and is
 * refused there as `PAGE_PARENT_NOT_ALLOWED`, rather than being unrepresentable
 * here and refused nowhere a route can see.
 */
export interface PageParentInput {
  kind: string;
  id?: string | null;
}

/** A page's parent, as the service reports it — the same shape a request names. */
export type PageParentDto =
  | { kind: 'root' }
  | { kind: 'folder'; id: string }
  | { kind: 'page'; id: string };

export interface MovePageInput {
  projectId: string;
  pageId: string;
  parent: PageParentInput;
  /** The page at the destination the moved page lands right AFTER. */
  beforeId?: string | null;
  /** The page at the destination the moved page lands right BEFORE. */
  afterId?: string | null;
}

/** Where a move left the page. `moved` is false for a move to where it already was. */
export interface PageMoveResultDto {
  id: string;
  parent: PageParentDto;
  position: string;
  /** The page's ancestors, root-first, the page itself excluded. */
  ancestorPageIds: string[];
  moved: boolean;
}

export interface ListPageTreeLevelInput {
  projectId: string;
  parent: PageParentInput;
  /** The opaque `nextCursor` of the previous read; omitted for the first. */
  cursor?: string | null;
  /** Rows per read: `PAGE_LEVEL_PAGE_SIZE` by default, `PAGE_LEVEL_PAGE_SIZE_MAX` at most. */
  limit?: number;
}

/** One row of a `/pages` tree level: a folder (at the root or in a folder) or a page. */
export type PageTreeRowDto =
  | { kind: 'folder'; id: string; name: string; hasChildren: boolean }
  | { kind: 'page'; id: string; title: string; hasChildren: boolean };

/**
 * One read of a tree level: folders first, then pages. `nextCursor` is `null`
 * when the level is exhausted; otherwise it is passed back verbatim.
 */
export interface PageTreeLevelDto {
  rows: PageTreeRowDto[];
  nextCursor: string | null;
}

export interface GetPageTrailInput {
  projectId: string;
  pageId: string;
}

/**
 * A page's breadcrumb, root-first and EXCLUDING the page itself: the folder
 * chain its topmost page is filed in, then its ancestor pages. Either may be
 * empty.
 */
export interface PageTrailDto {
  folders: Array<{ id: string; name: string }>;
  pages: Array<{ id: string; title: string }>;
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
