import {
  CrossProjectPageParentError,
  PageFolderNotFoundError,
  PageNeighbourInvalidError,
  PageNotFoundError,
} from './errors';
import { positionBetween } from './position';
import type { PageRow, PageStore, SubtreePage } from './store';
import { planPlacement, type ParentPage } from './tree';
import type { PagePlacement } from './types';

// The MOVE procedure (Story MOTIR-5753 · MOTIR-7368), `docs/decisions/pages.md`
// §4: where a page may go, checked and planned here and persisted through a
// `PageStore`. The service owns the transaction and the permission gate; this
// owns the ORDER, which is what keeps two concurrent moves from building a
// cycle the other's check could not see:
//   * the project's placement lock first, then the page's row lock;
//   * the parent read (missing, then another project), then the subtree;
//   * the tree rules in `planPlacement`'s order — a cycle, then too deep;
//   * the neighbours checked against the TARGET level before a key is minted;
//   * the page's write, then ONE rewrite of every descendant's ancestors.
// A refusal at any step leaves the store untouched.

/**
 * Read and check the parent a placement names, refusing a missing parent and a
 * parent in another project. Returns the parent page's facts under a page, and
 * nothing at the root or in a folder (whose pages start a chain of their own).
 * Shared by the create and the move.
 */
export async function resolvePlacementParent(
  store: PageStore,
  projectId: string,
  parent: PagePlacement,
): Promise<ParentPage | undefined> {
  if (parent.kind === 'root') return undefined;
  if (parent.kind === 'folder') {
    const folder = await store.findFolder(parent.folderId);
    if (!folder) throw new PageFolderNotFoundError(parent.folderId);
    if (folder.projectId !== projectId) {
      throw new CrossProjectPageParentError('folder', parent.folderId);
    }
    return undefined;
  }
  const page = await store.findPage(parent.pageId);
  if (!page) throw new PageNotFoundError(parent.pageId);
  if (page.projectId !== projectId) throw new CrossProjectPageParentError('page', parent.pageId);
  return { id: page.id, ancestorPageIds: page.ancestorPageIds };
}

/** The two columns a placement writes, from the placement. A sub-page carries no folder. */
export function placementColumns(parent: PagePlacement): {
  parentPageId: string | null;
  folderId: string | null;
} {
  return {
    parentPageId: parent.kind === 'page' ? parent.pageId : null,
    folderId: parent.kind === 'folder' ? parent.folderId : null,
  };
}

/** Levels in a subtree, the page itself counting 1 — `assertWithinDepth`'s `subtreeHeight`. */
export function subtreeHeight(page: SubtreePage, descendants: readonly SubtreePage[]): number {
  let height = 1;
  for (const descendant of descendants) {
    height = Math.max(height, descendant.ancestorPageIds.length - page.ancestorPageIds.length + 1);
  }
  return height;
}

/** Whether `page` already sits at `parent`. */
function sitsAt(page: PageRow, parent: PagePlacement): boolean {
  const columns = placementColumns(parent);
  return page.parentPageId === columns.parentPageId && page.folderId === columns.folderId;
}

export interface MovePageInput {
  pageId: string;
  /** The project the caller is acting in; the page and its new parent must both be in it. */
  projectId: string;
  /** Where the page goes: a page, a folder or the project root. */
  parent: PagePlacement;
  /** The page at the target the moved page lands right AFTER; omitted at the start. */
  beforeId?: string | null;
  /** The page at the target the moved page lands right BEFORE; omitted at the end. */
  afterId?: string | null;
  actorId: string;
}

export interface MovePageResult {
  readonly page: PageRow;
  /** `false` for a move to the page's current place, which writes nothing. */
  readonly moved: boolean;
}

/**
 * Move a page — re-parent it, reorder it among its siblings, or both — carrying
 * its whole subtree. With no neighbour named, a re-parented page goes LAST at
 * its new level and a page left at its own parent stays where it is.
 */
export async function movePage(store: PageStore, input: MovePageInput): Promise<MovePageResult> {
  const beforeId = input.beforeId ?? null;
  const afterId = input.afterId ?? null;

  await store.lockSiblings(input.projectId, input.parent);
  const page = await store.lockPage(input.pageId);
  if (!page || page.projectId !== input.projectId) throw new PageNotFoundError(input.pageId);

  const parent = await resolvePlacementParent(store, input.projectId, input.parent);
  const descendants = await store.findSubtree(page.id);
  const { ancestorPageIds } = planPlacement({
    pageId: page.id,
    placement: input.parent,
    parent,
    subtreeHeight: subtreeHeight(page, descendants),
  });

  await assertNeighbour(store, input, page.id, 'before', beforeId);
  await assertNeighbour(store, input, page.id, 'after', afterId);
  const sameParent = sitsAt(page, input.parent);
  if (sameParent && beforeId === null && afterId === null) return { page, moved: false };

  const neighbours = await store.siblingNeighbours(
    input.projectId,
    input.parent,
    beforeId,
    afterId,
  );
  if (
    beforeId !== null &&
    afterId !== null &&
    neighbours.before !== null &&
    neighbours.after !== null &&
    neighbours.before >= neighbours.after
  ) {
    throw new PageNeighbourInvalidError('after', afterId, 'order');
  }
  // Already between the two named neighbours at its own parent: nothing to do.
  if (
    sameParent &&
    (neighbours.before === null || neighbours.before <= page.position) &&
    (neighbours.after === null || page.position <= neighbours.after)
  ) {
    return { page, moved: false };
  }

  const position = positionBetween(neighbours.before, neighbours.after);
  const moved = await store.updatePlacement(
    page.id,
    { ...placementColumns(input.parent), position, ancestorPageIds },
    input.actorId,
  );
  const ancestorsChanged =
    ancestorPageIds.length !== page.ancestorPageIds.length ||
    ancestorPageIds.some((id, i) => id !== page.ancestorPageIds[i]);
  // A reorder keeps every chain; a re-parent rewrites the subtree's in one write.
  if (ancestorsChanged && descendants.length > 0) {
    await store.rebaseDescendants(page.id, ancestorPageIds);
  }
  return { page: moved, moved: true };
}

/** Refuse a named neighbour that is the moving page itself or not a child of the target. */
async function assertNeighbour(
  store: PageStore,
  input: MovePageInput,
  pageId: string,
  side: 'before' | 'after',
  neighbourId: string | null,
): Promise<void> {
  if (neighbourId === null) return;
  if (neighbourId === pageId) throw new PageNeighbourInvalidError(side, neighbourId, 'self');
  const neighbour = await store.findPage(neighbourId);
  if (!neighbour || neighbour.projectId !== input.projectId || !sitsAt(neighbour, input.parent)) {
    throw new PageNeighbourInvalidError(side, neighbourId, 'not_sibling');
  }
}
