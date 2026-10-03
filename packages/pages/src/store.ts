import type { JSONContent } from '@tiptap/core';
import type { PagePlacement } from './types';

// The PORTS the save procedures write through (Story MOTIR-5752 · MOTIR-7274),
// `docs/decisions/pages.md` §2. The package decides what a create, a rename and
// a save write; the app persists it, through a `PageStore` it builds per
// transaction (`pageStoreFor(tx)` in `lib/pages/index.ts`).
//
// Only the methods the shipped procedures call are here. Later stories add
// their own with the procedures that call them: `findSubtree` and
// `updatePlacement` (MOTIR-5753), `setArchived` and `deletePages` (MOTIR-5755).
// The version methods are MOTIR-5754's (§6).

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
}

/** The time source, injected so time-dependent rules are testable without fake timers. */
export interface Clock {
  now(): Date;
}
