import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { resolveWorkItemIdsByKeys } from './workItemRef';
import { summarizeMovedItems } from './sprintRef';

// `move_to_backlog` (Story 7.8 · Subtask 7.8.10) — the inverse of
// `move_to_sprint`: move a bulk selection of items OUT of their sprint and back
// to the backlog (`sprintId = null`) in ONE transaction. A thin adapter over
// `backlogService.bulkMoveToBacklog`: each item keeps its `backlogRank` (so it
// re-appears in the backlog in order), an item already in the backlog is a
// per-item no-op, and the batch cap applies — all unchanged in the service.

export const MOVE_TO_BACKLOG_TOOL_NAME = 'move_to_backlog';

const inputSchema = {
  keys: z
    .array(z.string().min(1))
    .min(1)
    .describe('Work item identifiers to move to the backlog, e.g. ["PROD-7", "PROD-8"].'),
};

/** The adapter: resolve the keys to ids, then bulk-move to the backlog. */
export async function runMoveToBacklog(
  args: { keys: string[] },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const ids = await resolveWorkItemIdsByKeys(args.keys, ctx);
    const moved = await backlogService.bulkMoveToBacklog(ids, ctx);
    return toolOk(summarizeMovedItems(moved, 'the backlog'), { items: moved });
  } catch (err) {
    return toToolError(err);
  }
}

export function registerMoveToBacklog(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    MOVE_TO_BACKLOG_TOOL_NAME,
    {
      title: 'Move work items to backlog',
      description:
        'Move work items (by identifier) out of their sprint and back to the backlog, in one ' +
        'atomic move. Each item keeps its backlog order; an item already in the backlog is ' +
        'unchanged. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runMoveToBacklog(args, resolveContext(extra)),
  );
}
