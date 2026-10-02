import type {
  DeleteFolderResultDto,
  FolderDeletionPreviewDto,
  FolderDto,
  ProjectFoldersDto,
} from '@/lib/dto/folders';

// THE FOLDER COMMANDS' TRANSPORT, as a component sees it (Story MOTIR-5753 ·
// MOTIR-7374). The folder writes are server actions that live with `/items`
// (`app/(authed)/items/actions.ts`), and `components/` may not import `app/` —
// so a tree outside `/items` (the `/pages` tree) is HANDED the actions by its
// page, which may import them, as props. These shapes are the structural
// contract those actions already satisfy; nothing here re-implements them.

/** A folder write's refusal: the action's stable code, its English message, and the colliding name when known. */
export interface FolderActionFailure {
  ok: false;
  code: string;
  error: string;
  folderName?: string | null;
}

export type FolderActionWriteResult = { ok: true; folder: FolderDto } | FolderActionFailure;

export interface FolderCommandActions {
  createFolder: (input: {
    parentFolderId: string | null;
    name: string;
  }) => Promise<FolderActionWriteResult>;
  renameFolder: (input: { folderId: string; name: string }) => Promise<FolderActionWriteResult>;
  moveFolder: (input: {
    folderId: string;
    targetParentFolderId: string | null;
    beforeId?: string | null;
    afterId?: string | null;
  }) => Promise<FolderActionWriteResult>;
  listProjectFolders: () => Promise<
    { ok: true; data: ProjectFoldersDto } | { ok: false; error: string }
  >;
  describeFolderDeletion: (input: {
    folderId: string;
  }) => Promise<{ ok: true; preview: FolderDeletionPreviewDto } | FolderActionFailure>;
  deleteFolder: (input: {
    folderId: string;
  }) => Promise<{ ok: true; result: DeleteFolderResultDto } | FolderActionFailure>;
}
