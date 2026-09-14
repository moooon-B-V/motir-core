import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { listFoldersPayload } from '../payloads/folders';
import {
  folderProjectKeyField,
  presentFolderRow,
  renderFolderTree,
  resolveFolderProject,
} from './folderRef';

// `list_folders` (Story MOTIR-5310 · MOTIR-5409) — every folder of a project in
// ONE read, each with its `path` (names root-first).
//
// ── The WHOLE tree, not a level ─────────────────────────────────────────────
// An agent resolving "the Backlog ideas folder" needs every path at once, the
// way `skeleton` hands it the whole work-item tree. So this reads
// `foldersService.listProjectFolders` — the Move to… picker's read — rather than
// `/api/v1`'s paged level (`listFolderLevel`), and inherits its cap
// (`FOLDER_PICKER_MAX`). `truncated` is on every response, so a bounded answer
// is never mistaken for a whole one.

export const LIST_FOLDERS_TOOL_NAME = 'list_folders';

const inputSchema = {
  projectKey: folderProjectKeyField,
};

/** The adapter: resolve the project by key, then read its folder tree. */
export async function runListFolders(
  args: { projectKey: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolveFolderProject(args.projectKey, ctx);
    const tree = await foldersService.listProjectFolders({ projectId: project.id }, ctx);
    const count = tree.folders.length;
    const text =
      count === 0
        ? `${project.identifier} has no folders.`
        : `${project.identifier} — ${count} folder(s)` +
          (tree.truncated
            ? '; TRUNCATED — this is NOT every folder in the project.'
            : ', the whole tree.') +
          `\n${renderFolderTree(tree.folders)}`;
    return toolOk(
      text,
      derived(listFoldersPayload, {
        projectKey: project.identifier,
        folders: tree.folders.map(presentFolderRow),
        truncated: tree.truncated,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerListFolders(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_FOLDERS_TOOL_NAME,
    {
      title: 'List folders',
      description:
        'Every folder of a project in ONE read, in tree order — each with its `id`, ' +
        '`parentFolderId`, `name` and `path` (the folder’s name and every ancestor’s, root ' +
        'first, e.g. ["Parked", "2025"]). Call this to find a folder by name before filing ' +
        'work into it or changing it; the other folder tools take its `id`. `truncated` is ' +
        'always reported, so a bounded answer is never mistaken for the whole tree. Read-only. ' +
        'Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runListFolders(args, resolveContext(extra)),
  );
}
