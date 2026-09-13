/**
 * A FOLDER on the wire (Epic MOTIR-5307 · Story MOTIR-5308 · MOTIR-5313) — a
 * named, nestable place in a project's tree that carries no workflow.
 *
 * Drops `workspaceId` (implicit in every read that serves it) and serialises
 * the timestamps as ISO-8601 so the DTO is JSON-safe across a Server Action.
 */
export interface FolderDto {
  id: string;
  projectId: string;
  /** The folder this one sits in, or `null` at the project root. */
  parentFolderId: string | null;
  name: string;
  /** Fractional index among sibling folders — what a reorder reasons about. */
  position: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFolderInput {
  projectId: string;
  /** `null` creates the folder at the project root. */
  parentFolderId: string | null;
  name: string;
}

export interface RenameFolderInput {
  projectId: string;
  folderId: string;
  name: string;
}

/**
 * A move, a reorder, or both. The neighbour ids use `MoveWorkItemInput`'s
 * semantics exactly, so the tree has one vocabulary for "put it here".
 */
export interface MoveFolderInput {
  projectId: string;
  folderId: string;
  /** The destination folder, or `null` for the project root. */
  targetParentFolderId: string | null;
  /** The sibling folder the moved one should sort AFTER. */
  beforeId?: string | null;
  /** The sibling folder the moved one should sort BEFORE. */
  afterId?: string | null;
}

export interface DeleteFolderInput {
  projectId: string;
  folderId: string;
}

/**
 * What a delete did. Nothing inside a folder is deleted with it: its child
 * folders and filed work items move to `destinationFolderId` (the deleted
 * folder's own parent, or `null` for the root), and these lists name them so a
 * surface can update in place and a confirmation can say what moved.
 */
export interface DeleteFolderResultDto {
  deletedFolderId: string;
  destinationFolderId: string | null;
  movedFolderIds: string[];
  movedWorkItemIds: string[];
}

export interface FileWorkItemInput {
  /** The folder to file into, or `null` to take the item out of its folder. */
  folderId: string | null;
}

/** A work item's placement after filing it into, or out of, a folder. */
export interface FileWorkItemResultDto {
  workItemId: string;
  folderId: string | null;
  /** Always `null` once filed: a work item is under a work item OR in a folder. */
  parentId: string | null;
  position: string;
}

/**
 * One option of the folder picker (Story MOTIR-5308 · MOTIR-5343). `path` is the
 * folder's name and every ancestor's, root first — what the picker shows
 * (*Later ▸ 2025*) and what its search matches.
 */
export interface FolderPickerNodeDto {
  id: string;
  parentFolderId: string | null;
  name: string;
  position: string;
  path: string[];
}

export interface ListProjectFoldersInput {
  projectId: string;
  /**
   * At most this many folders; clamped to `FOLDER_PICKER_MAX`. Only a test
   * lowers it — every surface takes the default.
   */
  limit?: number;
}

/**
 * A project's folders in TREE ORDER — each folder followed by its descendants,
 * siblings by position. `truncated` says the project holds more than were read,
 * so a picker states it rather than silently omitting folders.
 */
export interface ProjectFoldersDto {
  folders: FolderPickerNodeDto[];
  truncated: boolean;
}

export interface DescribeFolderDeletionInput {
  projectId: string;
  folderId: string;
}

/**
 * What deleting a folder WOULD move, and where — read before the person
 * confirms. The counts are the sets `deleteFolder` moves: direct child folders,
 * and every work item filed directly in the folder (archived and triaged ones
 * included, because they move too).
 */
export interface FolderDeletionPreviewDto {
  folderId: string;
  name: string;
  childFolderCount: number;
  workItemCount: number;
  /** The deleted folder's parent; both fields `null` for the project root. */
  destination: { folderId: string | null; name: string | null };
}
