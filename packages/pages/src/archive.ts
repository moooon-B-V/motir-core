import { PAGE_DEPTH_LIMIT } from './constants';
import {
  PageArchiveRootRequiredError,
  PageArchivedError,
  PageNotArchivedError,
  PageNotFoundError,
} from './errors';
import { placementColumns, sitsAt, subtreeHeight, writePlacement } from './move';
import { positionBetween } from './position';
import type { Clock, PageRow, PageStore, SubtreePage } from './store';
import type { PagePlacement } from './types';

// ARCHIVE, RESTORE and DELETE (Story MOTIR-5755 · MOTIR-7418),
// `docs/decisions/pages.md` §7 and its AMENDMENT 2. Pure procedures over the
// `PageStore`: the service owns the transaction and the permission gate
// (`page:edit` to archive and restore, `page:delete` to delete); these own the
// SET each operation takes and the ORDER of its writes.
//
//   * An ARCHIVE SET is the page a member archived (its root) and every
//     descendant that was live at that moment, all stamped with the root's id.
//     A descendant archived earlier keeps its own root and is not taken.
//   * A RESTORE brings back exactly that set — never a sub-page alone — to the
//     first rung of the landing ladder (`restoreLanding`) that still holds.
//   * A DELETE takes exactly that set too, and only from the archive.
//
// Every procedure takes the project's placement lock, then the root's row lock
// — `movePage`'s order — so an archive, a restore or a delete serialises with a
// move or a create of the same subtree, and none of them can deadlock another.

/** What every archive procedure is handed. */
export interface ArchiveProcedureInput {
  pageId: string;
  /** The project the caller acts in; a page from another reads as missing. */
  projectId: string;
  actorId: string;
}

const placementOf = (page: Pick<PageRow, 'parentPageId' | 'folderId'>): PagePlacement =>
  page.parentPageId !== null
    ? { kind: 'page', pageId: page.parentPageId }
    : page.folderId !== null
      ? { kind: 'folder', folderId: page.folderId }
      : { kind: 'root' };

/**
 * The lock order every procedure here shares: read the page to name its level,
 * take the placement lock, then re-read the page under its row lock.
 */
async function lockForArchive(store: PageStore, input: ArchiveProcedureInput): Promise<PageRow> {
  const seen = await store.findPage(input.pageId);
  if (!seen || seen.projectId !== input.projectId) throw new PageNotFoundError(input.pageId);
  await store.lockSiblings(input.projectId, placementOf(seen));
  const page = await store.lockPage(input.pageId);
  if (!page || page.projectId !== input.projectId) throw new PageNotFoundError(input.pageId);
  return page;
}

/** Refuse a live page and an archived page that is not its archive's root. */
function assertArchiveRoot(page: PageRow): void {
  if (page.archivedAt === null || page.archiveRootId === null) {
    throw new PageNotArchivedError(page.id);
  }
  if (page.archiveRootId !== page.id) {
    throw new PageArchiveRootRequiredError(page.id, page.archiveRootId);
  }
}

// ── Archive ─────────────────────────────────────────────────────────────────

export interface ArchivePageResult {
  /** The archive set: the root first, then every descendant that was live. */
  readonly archivedIds: readonly string[];
  readonly rootId: string;
}

/**
 * Archive a page with its sub-tree: the page and every LIVE descendant are
 * stamped, in one write, with this archive's root and actor. A descendant that
 * was archived earlier keeps its own root, so it stays out of this set.
 */
export async function archivePage(
  store: PageStore,
  clock: Clock,
  input: ArchiveProcedureInput,
): Promise<ArchivePageResult> {
  const page = await lockForArchive(store, input);
  if (page.archivedAt !== null) throw new PageArchivedError(page.id);
  const descendants = await store.findSubtree(page.id);
  const archivedIds = [
    page.id,
    ...descendants.filter((d) => d.archivedAt === null).map((d) => d.id),
  ];
  await store.setArchived(archivedIds, clock.now(), page.id, input.actorId);
  return { archivedIds, rootId: page.id };
}

// ── The restore landing ladder (pure) ───────────────────────────────────────

/** Which rung a restore landed on. Anything but `original` shows the restored-elsewhere notice. */
export type RestoreLandingKind = 'original' | 'ancestorPage' | 'folder' | 'root';

/** An ancestor of the root as it stands NOW — its current chain and folder, and whether live. */
export interface LandingAncestor {
  readonly ancestorPageIds: readonly string[];
  readonly folderId: string | null;
  readonly live: boolean;
}

export interface RestoreLandingInput {
  /** The archive root, as stored: its ORIGINAL placement and chain. */
  readonly root: Pick<PageRow, 'id' | 'parentPageId' | 'folderId' | 'ancestorPageIds'>;
  /** Levels the restored page brings, the root counting 1 (every descendant, archived or not). */
  readonly subtreeHeight: number;
  /**
   * Every page named by the root's `ancestorPageIds` that still EXISTS, live or
   * archived, by id. A deleted ancestor is simply absent.
   */
  readonly ancestors: ReadonlyMap<string, LandingAncestor>;
  /** Whether a folder still exists. */
  readonly folderExists: (folderId: string) => boolean;
}

export interface RestoreLanding {
  readonly kind: RestoreLandingKind;
  readonly parent: PagePlacement;
  /** The root's chain at the landing. */
  readonly ancestorPageIds: readonly string[];
}

/** Whether a page with `ancestorPageIds` and its subtree stay within the depth limit. */
const fits = (ancestorPageIds: readonly string[], height: number): boolean =>
  ancestorPageIds.length + height <= PAGE_DEPTH_LIMIT;

/**
 * WHERE A RESTORE LANDS (§7, AMENDMENT 2). The first rung that holds wins:
 *   1. the root's own parent page, when it exists and is live — or its own
 *      folder, when that exists — or the project root, when it was there;
 *   2. the nearest page up `ancestorPageIds` that exists and is live;
 *   3. the topmost ancestor's folder (the root's own, with no ancestors), when
 *      that folder exists;
 *   4. the project root.
 * A rung whose landing would put the deepest restored page past
 * `PAGE_DEPTH_LIMIT` is skipped as if it did not survive. Rung 4 always fits:
 * the subtree was within the limit when it was archived, and a root-level page
 * is as shallow as a page can be.
 */
export function restoreLanding(input: RestoreLandingInput): RestoreLanding {
  const { root, ancestors, folderExists } = input;
  const height = input.subtreeHeight;
  const underPage = (id: string): string[] | null => {
    const ancestor = ancestors.get(id);
    if (!ancestor?.live) return null;
    const chain = [...ancestor.ancestorPageIds, id];
    return fits(chain, height) ? chain : null;
  };

  // 1. The original place.
  if (root.parentPageId !== null) {
    const chain = underPage(root.parentPageId);
    if (chain) {
      return {
        kind: 'original',
        parent: { kind: 'page', pageId: root.parentPageId },
        ancestorPageIds: chain,
      };
    }
  } else if (root.folderId !== null) {
    if (folderExists(root.folderId)) {
      return {
        kind: 'original',
        parent: { kind: 'folder', folderId: root.folderId },
        ancestorPageIds: [],
      };
    }
  } else {
    return { kind: 'original', parent: { kind: 'root' }, ancestorPageIds: [] };
  }

  // 2. The nearest surviving ancestor page, nearest first.
  for (let i = root.ancestorPageIds.length - 1; i >= 0; i -= 1) {
    const id = root.ancestorPageIds[i]!;
    if (id === root.parentPageId) continue;
    const chain = underPage(id);
    if (chain)
      return { kind: 'ancestorPage', parent: { kind: 'page', pageId: id }, ancestorPageIds: chain };
  }

  // 3. The topmost ancestor's folder — or the root's own, when it has none.
  const topmostId = root.ancestorPageIds[0];
  const folderId =
    topmostId === undefined ? root.folderId : (ancestors.get(topmostId)?.folderId ?? null);
  if (folderId !== null && folderExists(folderId)) {
    return { kind: 'folder', parent: { kind: 'folder', folderId }, ancestorPageIds: [] };
  }

  // 4. The project root.
  return { kind: 'root', parent: { kind: 'root' }, ancestorPageIds: [] };
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface RestorePageResult {
  /** Exactly the archive set, the root first. */
  readonly restoredIds: readonly string[];
  readonly landing: {
    readonly kind: RestoreLandingKind;
    readonly parentPageId: string | null;
    readonly folderId: string | null;
  };
}

/**
 * Restore an archive ROOT with exactly its set. The root returns to the first
 * rung of {@link restoreLanding} that holds; on its original place it keeps its
 * position unless a live sibling now holds it, and anywhere else it goes last.
 * A sub-page archived on its own earlier is not in the set and stays archived.
 */
export async function restorePage(
  store: PageStore,
  input: ArchiveProcedureInput,
): Promise<RestorePageResult> {
  const root = await lockForArchive(store, input);
  assertArchiveRoot(root);
  const set = await store.findArchiveSet(root.id);
  const descendants = await store.findSubtree(root.id);

  const ancestors = new Map<string, LandingAncestor>();
  for (const id of root.ancestorPageIds) {
    const ancestor = await store.findPage(id);
    if (ancestor && ancestor.projectId === input.projectId) {
      ancestors.set(id, {
        ancestorPageIds: ancestor.ancestorPageIds,
        folderId: ancestor.folderId,
        live: ancestor.archivedAt === null,
      });
    }
  }
  const topmost = root.ancestorPageIds[0];
  const folderIds = new Set<string>();
  for (const id of [
    root.folderId,
    topmost === undefined ? null : ancestors.get(topmost)?.folderId,
  ]) {
    if (id === null || id === undefined) continue;
    const folder = await store.findFolder(id);
    if (folder && folder.projectId === input.projectId) folderIds.add(id);
  }

  const landing = restoreLanding({
    root,
    subtreeHeight: subtreeHeight(root, descendants),
    ancestors,
    folderExists: (id) => folderIds.has(id),
  });

  // On its original level the root keeps its place unless a LIVE sibling now
  // holds that exact key; anywhere else it goes last among the live pages there
  // (the root is not one of them yet).
  const keepPosition =
    landing.kind === 'original' &&
    !(await store.positionTaken(input.projectId, landing.parent, root.position));
  const position = keepPosition
    ? root.position
    : positionBetween(await store.lastSiblingPosition(input.projectId, landing.parent), null);
  const chainChanged =
    landing.ancestorPageIds.length !== root.ancestorPageIds.length ||
    landing.ancestorPageIds.some((id, i) => id !== root.ancestorPageIds[i]);
  if (position !== root.position || chainChanged || !sitsAt(root, landing.parent)) {
    await writePlacement(store, {
      page: root,
      parent: landing.parent,
      position,
      ancestorPageIds: landing.ancestorPageIds,
      hasDescendants: descendants.length > 0,
      actorId: input.actorId,
    });
  }

  const restoredIds = orderedSet(root.id, set);
  await store.setArchived(restoredIds, null, null, null);
  return {
    restoredIds,
    landing: { kind: landing.kind, ...placementColumns(landing.parent) },
  };
}

/** A set's ids with its root first. */
function orderedSet(rootId: string, set: readonly SubtreePage[]): string[] {
  return [rootId, ...set.filter((page) => page.id !== rootId).map((page) => page.id)];
}

// ── Delete ──────────────────────────────────────────────────────────────────

export interface DeletePageResult {
  /** Exactly the archive set, the root first. */
  readonly deletedIds: readonly string[];
}

/**
 * PERMANENTLY delete an archive ROOT with exactly its set — only from the
 * archive (a live page is refused, "archive it first"). Versions go with it.
 *
 * A sub-page archived on its own earlier is NOT in the set, but it is still a
 * descendant, and `parent_page_id` would refuse deleting its parent. So the
 * topmost of each such group is first RE-HOMED to the deleted root's own place
 * (its parent page or folder, and its position) and stays archived; its own
 * restore later starts its ladder there.
 */
export async function deletePage(
  store: PageStore,
  input: ArchiveProcedureInput,
): Promise<DeletePageResult> {
  const root = await lockForArchive(store, input);
  assertArchiveRoot(root);
  const set = await store.findArchiveSet(root.id);
  const deletedIds = orderedSet(root.id, set);
  const doomed = new Set(deletedIds);

  const descendants = await store.findSubtree(root.id);
  const rootPlacement = placementOf(root);
  for (const page of descendants) {
    if (doomed.has(page.id)) continue;
    // Topmost of a survivor group: its parent (the chain's last id) is doomed.
    const parentId = page.ancestorPageIds[page.ancestorPageIds.length - 1];
    if (parentId === undefined || !doomed.has(parentId)) continue;
    await writePlacement(store, {
      page,
      parent: rootPlacement,
      position: root.position,
      ancestorPageIds: root.ancestorPageIds,
      hasDescendants: descendants.some((d) => d.ancestorPageIds.includes(page.id)),
      actorId: input.actorId,
    });
  }

  await store.deletePages(deletedIds);
  return { deletedIds };
}
