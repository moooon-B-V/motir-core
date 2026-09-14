import { z } from 'zod';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';
import { FolderNotFoundError } from '@/lib/folders/errors';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpFolderRow } from '../payloads/folders';

// Shared folder-tool plumbing (Story MOTIR-5310 · MOTIR-5409). The four folder
// tools (`list_folders`, `create_folder`, `update_folder`, `delete_folder`) all
// address a project by its key and a folder by its opaque id. Kept in one place
// so the tools cannot drift on what a key or an id means. Like `sprintRef.ts`,
// this module holds no business logic: every refusal is `foldersService`'s own.

/** The zod field every folder tool shares for the project. */
export const folderProjectKeyField = z
  .string()
  .min(1)
  .describe('The project key the folders belong to (e.g. "ACME").');

/**
 * A folder is addressed by its opaque id, never by its name — names repeat
 * across levels. `list_folders` returns every folder's `id` beside its `path`.
 */
export const folderIdField = z
  .string()
  .min(1)
  .describe('The folder id (as returned by `list_folders`).');

/** Resolve a project key inside the token's workspace (browse-gated, 404-not-403). */
export async function resolveFolderProject(
  projectKey: string,
  ctx: ServiceContext,
): Promise<{ id: string; identifier: string }> {
  const project = await projectsService.getByKey(projectKey.trim().toUpperCase(), ctx);
  return { id: project.id, identifier: project.identifier };
}

/**
 * Hold an id-addressed folder to the project the call NAMED. `foldersService`'s
 * id-addressed writes resolve the project from the folder itself, so without this
 * a caller naming `ACME` could change a folder of `OTHER`. The refusal is the one
 * the project-addressed service writes raise for the folder being ACTED ON —
 * `FOLDER_NOT_FOUND` (only a DESTINATION in another project is the named
 * `CROSS_PROJECT_FOLDER` mistake).
 */
export async function assertFolderInProject(
  folderId: string,
  projectKey: string,
  ctx: ServiceContext,
): Promise<void> {
  const folder = await foldersService.getFolder(folderId, ctx);
  if (folder.projectKey !== projectKey) throw new FolderNotFoundError(folderId);
}

/** One `list_folders` row: the folder and its names root-first. */
export function presentFolderRow(node: FolderPickerNodeDto): McpFolderRow {
  return {
    id: node.id,
    parentFolderId: node.parentFolderId,
    name: node.name,
    path: node.path,
  };
}

/** The indented tree the `list_folders` text summary prints, one folder per line. */
export function renderFolderTree(rows: readonly FolderPickerNodeDto[]): string {
  return rows
    .map((row) => `${'  '.repeat(Math.max(0, row.path.length - 1))}- ${row.name} (${row.id})`)
    .join('\n');
}
