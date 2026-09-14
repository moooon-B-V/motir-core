import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { presentFolderDeletion } from '@/lib/api/v1/folders/schema';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { folderDeletionPayload } from '../payloads/folders';
import { folderIdField, folderProjectKeyField, resolveFolderProject } from './folderRef';

// `delete_folder` (Story MOTIR-5310 · MOTIR-5409) — a thin adapter over
// `foldersService.deleteFolder`. NOTHING inside the folder is deleted: its child
// folders and filed work items move up to the deleted folder's own parent (or
// the root), and the result — v1's `FolderDeletion` — names every id that moved,
// so an agent can say what happened without re-reading the tree.
//
// The project-addressed service write is used (not `deleteFolderById`) because
// the tool names its project: a folder of another project is refused as
// `CROSS_PROJECT_FOLDER` by the service itself. A retried delete on a folder
// that is already gone returns `FOLDER_NOT_FOUND`.

export const DELETE_FOLDER_TOOL_NAME = 'delete_folder';

const inputSchema = {
  projectKey: folderProjectKeyField,
  folderId: folderIdField,
};

/** The adapter: resolve the project by key, then delete the folder. */
export async function runDeleteFolder(
  args: { projectKey: string; folderId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolveFolderProject(args.projectKey, ctx);
    const result = presentFolderDeletion(
      await foldersService.deleteFolder({ projectId: project.id, folderId: args.folderId }, ctx),
    );
    const where = result.destinationFolderId
      ? `into ${result.destinationFolderId}`
      : 'to the project root';
    return toolOk(
      `Deleted folder ${result.deletedFolderId}; moved ${result.movedFolderIds.length} folder(s) ` +
        `and ${result.movedWorkItemIds.length} work item(s) ${where}.`,
      derived(folderDeletionPayload, result),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerDeleteFolder(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    DELETE_FOLDER_TOOL_NAME,
    {
      title: 'Delete folder',
      description:
        'Delete a folder (by id from `list_folders`). Nothing inside it is deleted: its folders ' +
        'and work items move up to the deleted folder’s parent, or to the project root, and the ' +
        'result lists every id that moved. A folder that is already gone returns ' +
        'FOLDER_NOT_FOUND. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runDeleteFolder(args, resolveContext(extra)),
  );
}
