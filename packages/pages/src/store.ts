import type { JSONContent } from '@tiptap/core';
import type { PagePlacement } from './types';

// The PORTS the save procedures write through (Story MOTIR-5752 · MOTIR-7274),
// `docs/decisions/pages.md` §2. The package decides what a create, a rename and
// a save write; the app persists it, through a `PageStore` it builds per
// transaction (`pageStoreFor(tx)` in `lib/pages/index.ts`).
//
// Only the methods THIS story's procedures call are here. Later stories add
// their own with the procedures that call them: `findSubtree` and
// `updatePlacement` (MOTIR-5753), the version methods (MOTIR-5754),
// `setArchived` and `deletePages` (MOTIR-5755).

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

/** The page persistence port — one instance per transaction. */
export interface PageStore {
  /** Reads one page `FOR UPDATE`, body state included; `null` if absent or out of scope. */
  lockPage(pageId: string): Promise<LockedPageRow | null>;
  /** Reads one page without its body; `null` if absent or out of scope. */
  findPage(pageId: string): Promise<PageRow | null>;
  /** Locks the sibling set of one parent, so two inserts mint distinct positions. */
  lockSiblings(projectId: string, parent: PagePlacement): Promise<void>;
  /** The greatest position among one parent's pages; `null` for an empty level. */
  lastSiblingPosition(projectId: string, parent: PagePlacement): Promise<string | null>;
  /** Creates a page. */
  insertPage(row: PageInsert): Promise<PageRow>;
  /** Writes the state and the three derived formats together. */
  updateBody(pageId: string, body: PageBodyWrite): Promise<void>;
  /** Renames a page; `null` if absent or out of scope. */
  updateTitle(pageId: string, title: string, updatedById: string): Promise<PageRow | null>;
  /** Rewrites a page's derived link rows (§8.1); a no-op until the linking epic lands. */
  replaceDerivedLinks(pageId: string, links: readonly DerivedPageLink[]): Promise<void>;
}

/** The time source, injected so time-dependent rules are testable without fake timers. */
export interface Clock {
  now(): Date;
}
