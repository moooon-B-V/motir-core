// Typed errors for the FOLDER domain (Epic MOTIR-5307 · Story MOTIR-5308 ·
// MOTIR-5313). Kept in their own file so callers — route handlers, Server
// Actions, the MCP tools — can import them without pulling in the Prisma
// client, the `lib/workItemTodos/errors.ts` precedent.
//
// The service throws these and the caller translates the stable `code`:
//   FolderNotFoundError         → 404 (a folder in another workspace is
//                                      indistinguishable from one that never
//                                      existed — finding #44, no existence leak)
//   InvalidFolderNameError      → 422 (empty after trimming, or over the cap)
//   FolderNameTakenError        → 409 (a sibling already has this name,
//                                      case-insensitively)
//   FolderCycleError            → 422 (a folder moved into itself or a descendant)
//   CrossProjectFolderError     → 422 (a target folder in another project)
//   SubtaskNeedsPlacementError  → 409 (deleting a ROOT folder would leave a
//                                      subtask with neither a parent nor a folder)
//
// There is deliberately no `FolderForbiddenError`: every folder write is gated
// on `work_item:edit` for the project, so the refusal is the project's own
// `ProjectAccessDeniedError('edit')`.

/** The longest a folder name may be, after trimming. */
export const FOLDER_NAME_MAX_LENGTH = 120;

export class FolderNotFoundError extends Error {
  readonly code = 'FOLDER_NOT_FOUND' as const;
  constructor(readonly folderId: string) {
    super(`Folder ${folderId} not found.`);
    this.name = 'FolderNotFoundError';
  }
}

export class InvalidFolderNameError extends Error {
  readonly code = 'INVALID_FOLDER_NAME' as const;
  readonly limit = FOLDER_NAME_MAX_LENGTH;
  constructor(
    readonly reason: 'empty' | 'too_long',
    readonly actual: number,
  ) {
    super(
      reason === 'empty'
        ? 'A folder needs a name.'
        : `A folder name is capped at ${FOLDER_NAME_MAX_LENGTH} characters (this one is ${actual}).`,
    );
    this.name = 'InvalidFolderNameError';
  }
}

export class FolderNameTakenError extends Error {
  readonly code = 'FOLDER_NAME_TAKEN' as const;
  /**
   * The colliding name, or `null` when the collision was caught by the unique
   * index during a race whose write did not carry the name to the repository.
   */
  constructor(readonly folderName: string | null) {
    super(
      folderName === null
        ? 'A folder with that name is already here.'
        : `A folder named "${folderName}" is already here.`,
    );
    this.name = 'FolderNameTakenError';
  }
}

export class FolderCycleError extends Error {
  readonly code = 'FOLDER_CYCLE' as const;
  constructor(message = 'A folder cannot be moved into itself or into one of its own folders.') {
    super(message);
    this.name = 'FolderCycleError';
  }
}

export class CrossProjectFolderError extends Error {
  readonly code = 'CROSS_PROJECT_FOLDER' as const;
  constructor(message = 'Folders are project-local: that folder belongs to another project.') {
    super(message);
    this.name = 'CrossProjectFolderError';
  }
}

export class SubtaskNeedsPlacementError extends Error {
  readonly code = 'SUBTASK_NEEDS_PLACEMENT' as const;
  constructor(readonly workItemIds: string[]) {
    super(
      `Deleting this folder would leave ${workItemIds.length} subtask(s) with neither a parent nor a folder. Move them first.`,
    );
    this.name = 'SubtaskNeedsPlacementError';
  }
}
