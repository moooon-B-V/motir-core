import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';

// `rename_page` (MOTIR-8841) — set a page's TITLE, under `page:edit`. A thin
// adapter over `pagesService.renamePage`, the operation the editor's rename
// route (`PATCH /api/pages/:id`) already calls.
//
// ── Why this is its own tool and not a `title` on `update_page` ─────────────
// `update_page` is "replace the body at the revision you read". A rename needs
// neither: it writes no body, so it takes no `revision` and cannot be refused
// PAGE_REVISION_CONFLICT, and it does not start a new version — a published
// decision page renamed here stays at the version it was sealed at.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): no `/api/v1`
// operation returns a page.

export const RENAME_PAGE_TOOL_NAME = 'rename_page';

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  title: z.string().describe('The page’s new title. An empty string makes it untitled.'),
};

interface RenamePageArgs {
  projectKey: string;
  pageId: string;
  title: string;
}

/** The adapter: resolve the project by key, then rename the page. */
export async function runRenamePage(
  args: RenamePageArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const page = await pagesService.renamePage(ctx, {
      projectId: project.id,
      pageId: args.pageId,
      title: args.title,
    });
    return toolOk(
      `Renamed page ${page.id} to ${page.title || 'Untitled'}.`,
      exempt(RENAME_PAGE_TOOL_NAME, { ...page }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerRenamePage(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    RENAME_PAGE_TOOL_NAME,
    {
      title: 'Rename page',
      description:
        'Change a page’s TITLE. Writes no body, so it takes no `revision`, cannot conflict with ' +
        'a save, and does not start a new version — a published decision page keeps the version ' +
        'it was published at. To change the body use `update_page`. Returns the page’s id, ' +
        'title and current `revision`. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runRenamePage(args, resolveContext(extra)),
  );
}
