import { PAGE_DEPTH_LIMIT } from './constants';
import { PageCycleError, PageDepthExceededError, PageParentNotAllowedError } from './errors';
import type { PagePlacement, PageTreeNode } from './types';

// The PURE tree rules of `docs/decisions/pages.md` §4. They read only what they
// are handed — the service reads the rows under `lockSiblings` and calls these —
// so the same refusals hold whichever store sits behind the port.

/** A placement as a request names it, before it is checked. */
export interface PlacementInput {
  readonly kind: string;
  readonly id?: string | null;
}

/**
 * Turn a requested placement into a {@link PagePlacement}. A page's parent is a
 * page, a folder or the root, and nothing else: a work item, or any other kind,
 * is refused with {@link PageParentNotAllowedError}.
 */
export function parsePlacement(input: PlacementInput): PagePlacement {
  switch (input.kind) {
    case 'root':
      return { kind: 'root' };
    case 'folder':
      return { kind: 'folder', folderId: requireId(input) };
    case 'page':
      return { kind: 'page', pageId: requireId(input) };
    default:
      throw new PageParentNotAllowedError(input.kind);
  }
}

function requireId(input: PlacementInput): string {
  if (!input.id) {
    throw new TypeError(`A "${input.kind}" placement needs the id of its ${input.kind}.`);
  }
  return input.id;
}

/** The parent page's facts a placement under it needs. */
export type ParentPage = Pick<PageTreeNode, 'id' | 'ancestorPageIds'>;

/**
 * The `ancestor_page_ids` a page takes at `placement`: empty at the root or in a
 * folder (a folder-filed page is level 1), the parent's chain plus the parent
 * under a page.
 */
export function ancestorIdsFor(placement: PagePlacement, parent?: ParentPage): string[] {
  if (placement.kind !== 'page') return [];
  if (!parent || parent.id !== placement.pageId) {
    throw new TypeError('A placement under a page needs that page’s ancestors.');
  }
  return [...parent.ancestorPageIds, parent.id];
}

/** A page's level: 1 at the root or in a folder, its parent's level plus one below a page. */
export function pageLevel(ancestorPageIds: readonly string[]): number {
  return ancestorPageIds.length + 1;
}

/**
 * Refuse placing `pageId` where its new ancestors include itself — under itself
 * or under one of its own sub-pages.
 */
export function assertNoCycle(pageId: string, newAncestorPageIds: readonly string[]): void {
  if (newAncestorPageIds.includes(pageId)) {
    const parentPageId = newAncestorPageIds[newAncestorPageIds.length - 1] ?? pageId;
    throw new PageCycleError(pageId, parentPageId);
  }
}

/**
 * Refuse a placement that puts any page past {@link PAGE_DEPTH_LIMIT}. A move is
 * checked against the deepest page of the moving subtree: `subtreeHeight` is 1
 * for a page with no sub-pages, 2 with children, and so on.
 */
export function assertWithinDepth(newAncestorPageIds: readonly string[], subtreeHeight = 1): void {
  if (!Number.isInteger(subtreeHeight) || subtreeHeight < 1) {
    throw new RangeError('subtreeHeight is at least 1: the page itself.');
  }
  const deepest = newAncestorPageIds.length + subtreeHeight;
  if (deepest > PAGE_DEPTH_LIMIT) throw new PageDepthExceededError(deepest);
}

/** What a create or a move asks of the tree rules. */
export interface PlacementRequest {
  /** The page being moved; omitted on a create, which cannot form a cycle. */
  readonly pageId?: string;
  readonly placement: PagePlacement;
  /** The parent page's facts, required when `placement.kind` is `page`. */
  readonly parent?: ParentPage;
  /** Height of the moving subtree; 1 on a create. */
  readonly subtreeHeight?: number;
}

/**
 * Check a create or a move against every tree rule and return the page's new
 * `ancestor_page_ids`. Refuses, in order: a cycle, then too deep.
 */
export function planPlacement(request: PlacementRequest): { ancestorPageIds: string[] } {
  const ancestorPageIds = ancestorIdsFor(request.placement, request.parent);
  if (request.pageId !== undefined) assertNoCycle(request.pageId, ancestorPageIds);
  assertWithinDepth(ancestorPageIds, request.subtreeHeight ?? 1);
  return { ancestorPageIds };
}

/**
 * A descendant's `ancestor_page_ids` after `movedPageId` moved to sit under
 * `movedNewAncestorIds` — the rewrite §4 does for the whole subtree in the
 * move's transaction. The chain from the moved page down is kept; the part
 * above it is replaced.
 */
export function rebaseAncestorIds(
  descendantAncestorIds: readonly string[],
  movedPageId: string,
  movedNewAncestorIds: readonly string[],
): string[] {
  const at = descendantAncestorIds.indexOf(movedPageId);
  if (at === -1) {
    throw new RangeError(`The page is not a descendant of ${movedPageId}.`);
  }
  return [...movedNewAncestorIds, ...descendantAncestorIds.slice(at)];
}
