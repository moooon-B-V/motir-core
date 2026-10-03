import type { JSONContent } from '@tiptap/core';
import type { PagePlacement } from './types';

// The PORTS the save procedures write through (Story MOTIR-5752 · MOTIR-7274),
// `docs/decisions/pages.md` §2. The package decides what a create, a rename and
// a save write; the app persists it, through a `PageStore` it builds per
// transaction (`pageStoreFor(tx)` in `lib/pages/index.ts`).
//
// Only the methods the shipped procedures call are here. Later stories add
// their own with the procedures that call them: the version methods
// (MOTIR-5754 · §6). The placement methods (`findFolder`, `findSubtree`,
// `siblingNeighbours`, `updatePlacement`, `rebaseDescendants`) are the page
// tree's (MOTIR-5753 · MOTIR-7368); `setArchived`, `findArchiveSet`,
// `deletePages` and `positionTaken` are archive's (MOTIR-5755 · MOTIR-7418, §7).
//
// ⚠️ LIVE vs ARCHIVED (§7). The LEVEL reads — `lastSiblingPosition`,
// `siblingNeighbours`, `positionTaken` — see LIVE pages only: an archived page
// has left the tree, and its kept `position` must not shape a level it is not
// in. The ROW reads — `lockPage`, `findPage`, `findSubtree`, `findArchiveSet` —
// return archived pages too, and the procedures decide what an archived page
// may do.

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
  /** When the page was archived (§7); `null` while it is live. */
  readonly archivedAt: Date | null;
  /**
   * The page whose archive took this one — itself for the page a member
   * archived, that page for every sub-page that left with it. `null` while live.
   */
  readonly archiveRootId: string | null;
  /** Who archived it; `null` while live, or once that user is deleted. */
  readonly archivedById: string | null;
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

/**
 * One page of a subtree or an archive set: the facts the depth check and the
 * rewrite read, and whether — and by which archive — it is archived.
 */
export interface SubtreePage {
  readonly id: string;
  readonly ancestorPageIds: readonly string[];
  readonly archivedAt: Date | null;
  readonly archiveRootId: string | null;
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

/** One version of a page (§6), without its snapshot. */
export interface PageVersionRow {
  readonly id: string;
  readonly pageId: string;
  /** Per page, from 1, never reused — the next is always `max + 1`. */
  readonly number: number;
  readonly authorId: string;
  readonly startedAt: Date;
  readonly savedAt: Date;
  /** The source of a restore; `null` once that source is pruned. */
  readonly restoredFromVersionId: string | null;
  /** The source's number, kept when the source is pruned; `null` unless a restore. */
  readonly restoredFromNumber: number | null;
}

/** A version with its snapshot, as a restore reads it. */
export interface PageVersionWithBody extends PageVersionRow {
  readonly bodyState: Uint8Array;
  readonly bodyMarkdown: string;
}

/** A new version, as `insertVersion` writes it — its page's tenancy stamped on it. */
export interface PageVersionInsert {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly number: number;
  readonly authorId: string;
  readonly bodyState: Uint8Array;
  readonly bodyMarkdown: string;
  readonly startedAt: Date;
  readonly savedAt: Date;
  readonly restoredFromVersionId: string | null;
  readonly restoredFromNumber: number | null;
}

/** An extension of the latest version: its snapshot and `savedAt` move forward. */
export interface PageVersionUpdate {
  readonly bodyState: Uint8Array;
  readonly bodyMarkdown: string;
  readonly savedAt: Date;
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
  /**
   * Every DESCENDANT of a page (the page itself excluded), at any depth —
   * archived descendants INCLUDED, because a move carries them (they are still
   * its sub-pages) and archive, restore and delete must see them.
   */
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
  /** The newest version of a page; `null` when it has none. */
  latestVersion(pageId: string): Promise<PageVersionRow | null>;
  /** Writes a new version. */
  insertVersion(row: PageVersionInsert): Promise<PageVersionRow>;
  /** Extends a version: replaces its snapshot and moves its `savedAt`. */
  updateVersion(versionId: string, row: PageVersionUpdate): Promise<void>;
  /** Version `number` of THIS page, with its snapshot; `null` when it has no such version. */
  findVersion(pageId: string, number: number): Promise<PageVersionWithBody | null>;
  /** How many versions a page keeps. */
  countVersions(pageId: string): Promise<number>;
  /** Deletes a page's oldest versions until `keep` remain. */
  deleteOldestVersions(pageId: string, keep: number): Promise<void>;
  /** Rewrites a page's derived link rows (§8.1); a no-op until the linking epic lands. */
  replaceDerivedLinks(pageId: string, links: readonly DerivedPageLink[]): Promise<void>;
  /**
   * Stamps (or, with three `null`s, clears) the archive columns of every page in
   * `ids`, in ONE write (§7). Nothing else on the rows changes.
   */
  setArchived(
    ids: readonly string[],
    archivedAt: Date | null,
    archiveRootId: string | null,
    archivedById: string | null,
  ): Promise<void>;
  /** Every page whose `archiveRootId` is `rootId` — one archive set, its root included. */
  findArchiveSet(rootId: string): Promise<SubtreePage[]>;
  /**
   * Permanently deletes every page in `ids` in ONE statement, so the
   * `parent_page_id` foreign key is checked once, at its end; their versions go
   * with them (`page_version` cascades).
   */
  deletePages(ids: readonly string[]): Promise<void>;
  /** Whether a LIVE page at one parent's level already holds `position`. */
  positionTaken(projectId: string, parent: PagePlacement, position: string): Promise<boolean>;
}

/** The time source, injected so time-dependent rules are testable without fake timers. */
export interface Clock {
  now(): Date;
}
