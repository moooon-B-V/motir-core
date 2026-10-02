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
