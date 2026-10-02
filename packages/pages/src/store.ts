import type { JSONContent } from '@tiptap/core';
import type { PagePlacement } from './types';

// The PORTS the save procedures write through (Story MOTIR-5752 · MOTIR-7274),
// `docs/decisions/pages.md` §2. The package decides what a create, a rename and
// a save write; the app persists it, through a `PageStore` it builds per
// transaction (`pageStoreFor(tx)` in `lib/pages/index.ts`).
//
// Only the methods the shipped procedures call are here. Later stories add
// their own with the procedures that call them: the version methods
// (MOTIR-5754), `setArchived` and `deletePages` (MOTIR-5755). The placement
// methods (`findFolder`, `findSubtree`, `siblingNeighbours`, `updatePlacement`,
// `rebaseDescendants`) are the page tree's (MOTIR-5753 · MOTIR-7368).

/** A page row, without its body state. */
export interface PageRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly parentPageId: string | null;
  readonly folderId: string | null;
  readonly position: string;
  readonly ancestorPageIds: readonly string[];
  readonly revision: number;
  readonly createdById: string;
  readonly updatedById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A page row read under its lock, with the canonical body state. */
export interface LockedPageRow extends PageRow {
  readonly bodyState: Uint8Array;
}

/** A body write: the canonical state and the three formats derived from it, together. */
export interface PageBodyWrite {
  readonly state: Uint8Array;
  readonly json: JSONContent;
  readonly markdown: string;
  readonly text: string;
  readonly revision: number;
  readonly updatedById: string;
  readonly updatedAt: Date;
}

/** A new page, as `insertPage` writes it. */
export interface PageInsert {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly parentPageId: string | null;
  readonly folderId: string | null;
  readonly position: string;
  readonly ancestorPageIds: readonly string[];
  readonly body: PageBodyWrite;
  readonly createdById: string;
  readonly createdAt: Date;
}

/** A link a page body names (§8.1), written by the linking epic's extraction. */
export interface DerivedPageLink {
  readonly workItemId: string;
}

/** A folder, as a placement under it needs it: its identity and its project. */
export interface FolderRef {
  readonly id: string;
  readonly projectId: string;
}

/** One page of a moving subtree: the facts the depth check and the rewrite read. */
export interface SubtreePage {
  readonly id: string;
  readonly ancestorPageIds: readonly string[];
}

/**
 * The positions a move mints between, at its target level. `null` is the start
 * (`before`) or the end (`after`) of the level.
 */
export interface NeighbourPositions {
  readonly before: string | null;
  readonly after: string | null;
}

/** Where a page sits after a move — `updatePlacement`'s write. */
export interface PagePlacementWrite {
  readonly parentPageId: string | null;
  readonly folderId: string | null;
  readonly position: string;
  readonly ancestorPageIds: readonly string[];
}

/** The page persistence port — one instance per transaction. */
export interface PageStore {
  /** Reads one page `FOR UPDATE`, body state included; `null` if absent or out of scope. */
  lockPage(pageId: string): Promise<LockedPageRow | null>;
  /** Reads one page without its body; `null` if absent or out of scope. */
  findPage(pageId: string): Promise<PageRow | null>;
  /**
   * Serialises every PLACEMENT write in the project — a create, a move, a
   * subtree rewrite — for the caller's transaction, so two inserts mint distinct
   * positions and two moves cannot each pass the cycle check against a tree the
   * other is changing. `parent` names the level the caller writes into; an
   * adapter may lock more than that level, and the page tree's does: the whole
   * project.
   */
  lockSiblings(projectId: string, parent: PagePlacement): Promise<void>;
  /** The greatest position among one parent's pages; `null` for an empty level. */
  lastSiblingPosition(projectId: string, parent: PagePlacement): Promise<string | null>;
  /** Reads one folder; `null` if absent or out of scope. */
  findFolder(folderId: string): Promise<FolderRef | null>;
  /** Every DESCENDANT of a page (the page itself excluded), at any depth. */
  findSubtree(pageId: string): Promise<SubtreePage[]>;
  /**
   * The positions to mint between at one parent's level. `beforeId` names the
   * page the new position follows and `afterId` the page it precedes, each a
   * child of `parent` (the caller has checked). A side the caller did not name
   * is read from the level: with only `beforeId`, `after` is the page right
   * after it; with only `afterId`, `before` is the page right before it; with
   * neither, `before` is the level's last page and `after` is `null` — an
   * append.
   */
  siblingNeighbours(
    projectId: string,
    parent: PagePlacement,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<NeighbourPositions>;
  /** Creates a page. */
  insertPage(row: PageInsert): Promise<PageRow>;
  /** Writes the state and the three derived formats together. */
  updateBody(pageId: string, body: PageBodyWrite): Promise<void>;
  /** Renames a page; `null` if absent or out of scope. */
  updateTitle(pageId: string, title: string, updatedById: string): Promise<PageRow | null>;
  /** Moves one page: its parent, folder, position and ancestors, in one write. */
  updatePlacement(
    pageId: string,
    placement: PagePlacementWrite,
    updatedById: string,
  ): Promise<PageRow>;
  /**
   * Rewrites the `ancestor_page_ids` of every descendant of a moved page in ONE
   * write: the part of each chain above `pageId` is replaced by
   * `newAncestorPageIds` (`rebaseAncestorIds`, applied to the whole subtree).
   */
  rebaseDescendants(pageId: string, newAncestorPageIds: readonly string[]): Promise<void>;
  /** Rewrites a page's derived link rows (§8.1); a no-op until the linking epic lands. */
  replaceDerivedLinks(pageId: string, links: readonly DerivedPageLink[]): Promise<void>;
}

/** The time source, injected so time-dependent rules are testable without fake timers. */
export interface Clock {
  now(): Date;
}
