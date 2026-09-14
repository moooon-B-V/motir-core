import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { presentFolder } from '@/lib/api/v1/folders/schema';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { folderWritePayload } from '../payloads/folders';
import { folderProjectKeyField, resolveFolderProject } from './folderRef';

// `create_folder` (Story MOTIR-5310 · MOTIR-5409) — a thin adapter over
// `foldersService.createFolder`, the same write the `/items` tree's New folder
// uses, then the id-addressed `getFolder` read so the result is v1's `Folder`
// resource (with its `path`) — the same two calls `POST /api/v1/.../folders`
// makes. Name validation, sibling-name uniqueness and the same-project check all
// run in the service unchanged.
//
// ── Re-delivery ─────────────────────────────────────────────────────────────
// An agent retries on an unclear result. A retried create meets
// `FOLDER_NAME_TAKEN` naming the folder that already exists — so the description
// tells the agent to `list_folders` rather than retry again, which is how it
// finds the folder its first call created.

export const CREATE_FOLDER_TOOL_NAME = 'create_folder';

const inputSchema = {
  projectKey: folderProjectKeyField,
  name: z.string().describe('The new folder’s name. Unique among the folders at its level.'),
  parentFolderId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'The folder to create it inside (an id from `list_folders`). Omit or pass null to ' +
        'create it at the project root.',
    ),
};

interface CreateFolderArgs {
  projectKey: string;
  name: string;
  parentFolderId?: string | null;
}

/** The adapter: resolve the project by key, create the folder, read it back. */
export async function runCreateFolder(
  args: CreateFolderArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolveFolderProject(args.projectKey, ctx);
    const created = await foldersService.createFolder(
      { projectId: project.id, parentFolderId: args.parentFolderId ?? null, name: args.name },
      ctx,
    );
    const folder = presentFolder(await foldersService.getFolder(created.id, ctx));
    return toolOk(
      `Created folder ${folder.path.join(' ▸ ')} (${folder.id}) in ${folder.projectKey}.`,
      derived(folderWritePayload, folder),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCreateFolder(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CREATE_FOLDER_TOOL_NAME,
    {
      title: 'Create folder',
      description:
        'Create a folder in a project — at the root, or inside another folder by `parentFolderId`. ' +
        'A folder is a named place in the tree that holds work items and other folders and ' +
        'carries no workflow of its own. Names are unique among the folders at one level: a ' +
        'FOLDER_NAME_TAKEN refusal names the existing folder, so if you are retrying after an ' +
        'unclear result, call `list_folders` to find it instead of creating again. Honors the ' +
        'same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runCreateFolder(args, resolveContext(extra)),
  );
}
