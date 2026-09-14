import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { presentFolder, toUpdateFolderInput } from '@/lib/api/v1/folders/schema';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { folderWritePayload } from '../payloads/folders';
import {
  assertFolderInProject,
  folderIdField,
  folderProjectKeyField,
  resolveFolderProject,
} from './folderRef';

// `update_folder` (Story MOTIR-5310 · MOTIR-5409) — RENAME a folder, or PLACE it
// (move it into another folder and/or reorder it among its siblings). A thin
// adapter over `foldersService.updateFolder`, the id-addressed edit
// `PATCH /api/v1/folders/{folderId}` calls (MOTIR-5408).
//
// ── A rename OR a placement, never both ─────────────────────────────────────
// The service renames and moves in two separate transactions, so one call
// carrying both could half-apply. The split is `toUpdateFolderInput` — the SAME
// function the v1 PATCH uses, so the two doors cannot disagree about which
// arguments form a rename, which a placement, and what is refused. Its refusal
// (`INVALID_REQUEST`) is raised before either write runs.

export const UPDATE_FOLDER_TOOL_NAME = 'update_folder';

const inputSchema = {
  projectKey: folderProjectKeyField,
  folderId: folderIdField,
  name: z
    .string()
    .optional()
    .describe('RENAME: the folder’s new name. Do not combine with a placement.'),
  parentFolderId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'PLACE: the folder to move it into (an id from `list_folders`), or null for the project ' +
        'root. Omit to keep its current parent and only reorder it. Do not combine with `name`.',
    ),
  beforeId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('PLACE: the sibling folder this one should sort AFTER.'),
  afterId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('PLACE: the sibling folder this one should sort BEFORE.'),
};

interface UpdateFolderArgs {
  projectKey: string;
  folderId: string;
  name?: string;
  parentFolderId?: string | null;
  beforeId?: string | null;
  afterId?: string | null;
}

/** The adapter: split rename-or-placement, resolve the project, then update. */
export async function runUpdateFolder(
  args: UpdateFolderArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const { projectKey: _projectKey, folderId: _folderId, ...body } = args;
    const input = toUpdateFolderInput(body);
    const project = await resolveFolderProject(args.projectKey, ctx);
    await assertFolderInProject(args.folderId, project.identifier, ctx);
    const folder = presentFolder(await foldersService.updateFolder(args.folderId, input, ctx));
    const verb = 'name' in input ? 'Renamed' : 'Placed';
    return toolOk(
      `${verb} folder ${folder.path.join(' ▸ ')} (${folder.id}).`,
      derived(folderWritePayload, folder),
    );
  } catch (err) {
    // The rename-or-placement refusal is v1's own error class; surface its code.
    if (err instanceof InvalidRequestError) return toolError(err.code, err.message);
    return toToolError(err);
  }
}

export function registerUpdateFolder(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    UPDATE_FOLDER_TOOL_NAME,
    {
      title: 'Update folder',
      description:
        'Change a folder (by id from `list_folders`): EITHER rename it with `name`, OR place it ' +
        'with `parentFolderId` (another folder’s id, or null for the project root) and/or ' +
        '`beforeId` / `afterId` to set its order among its siblings. A rename and a placement in ' +
        'one call is refused — they are separate writes — so make two calls. Moving a folder ' +
        'into itself or one of its own folders is refused. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runUpdateFolder(args, resolveContext(extra)),
  );
}
