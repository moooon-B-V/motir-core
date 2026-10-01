// The page model `docs/decisions/pages.md` defines, as TYPES only. The app's
// schema story maps its rows onto these; nothing here knows about Prisma.

/**
 * Where a page sits (§4): under another page, filed in a folder, or at the
 * project root. There is no work-item variant, so "a page is never filed under
 * a work item" holds in the type as it does in the schema.
 */
export type PagePlacement =
  | { readonly kind: 'root' }
  | { readonly kind: 'folder'; readonly folderId: string }
  | { readonly kind: 'page'; readonly pageId: string };

/** The kinds a placement may name. */
export type PagePlacementKind = PagePlacement['kind'];

/** A page's tree facts, as the tree rules read them. */
export interface PageTreeNode {
  readonly id: string;
  readonly projectId: string;
  readonly placement: PagePlacement;
  /** Page ids root-first, excluding the page itself (`page.ancestor_page_ids`). */
  readonly ancestorPageIds: readonly string[];
  /** Fractional key among the pages that share this page's parent (`page.position`). */
  readonly position: string;
}

/** A page as a tree level lists it (§4). */
export interface PageSummary extends PageTreeNode {
  readonly title: string;
  readonly hasChildren: boolean;
  readonly archivedAt: Date | null;
}

/** The keyset cursor a level read pages on: `(position, id)` (§4). */
export interface PageLevelCursor {
  readonly position: string;
  readonly id: string;
}

/** The three permission keys of the `page` domain (§5). */
export type PagePermissionKey = 'page:view' | 'page:edit' | 'page:delete';
