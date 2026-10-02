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
