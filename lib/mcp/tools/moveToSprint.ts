import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { resolveWorkItemIdsByKeys } from './workItemRef';
import { sprintIdField, summarizeMovedItems } from './sprintRef';

// `move_to_sprint` (Story 7.8 · Subtask 7.8.10) — the "add work items to
// sprint" operation: assign a bulk selection of items to a sprint in ONE
// transaction (atomic — all or none). A thin adapter over
// `backlogService.bulkAssignToSprint`: the same-project guard
// (CrossProjectSprintAssignmentError), the bounded batch cap
// (BulkBatchTooLargeError), the per-item revision, and the append-to-tail rank
// all run in the service unchanged. The tool only resolves the `PROD-<n>` keys
// to ids first.

export const MOVE_TO_SPRINT_TOOL_NAME = 'move_to_sprint';

const inputSchema = {
  keys: z
    .array(z.string().min(1))
    .min(1)
    .describe('Work item identifiers to move, e.g. ["PROD-7", "PROD-8"].'),
  sprintId: sprintIdField,
};

/** The adapter: resolve the keys to ids, then bulk-assign to the sprint. */
export async function runMoveToSprint(
  args: { keys: string[]; sprintId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const ids = await resolveWorkItemIdsByKeys(args.keys, ctx);
    const moved = await backlogService.bulkAssignToSprint(ids, args.sprintId, ctx);
    return toolOk(summarizeMovedItems(moved, `sprint ${args.sprintId}`), { items: moved });
  } catch (err) {
    return toToolError(err);
  }
}

export function registerMoveToSprint(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    MOVE_TO_SPRINT_TOOL_NAME,
    {
      title: 'Move work items to sprint',
      description:
        'Add work items (by identifier) to a sprint (by id), in one atomic move — appended to ' +
        "the sprint in selection order. All items must belong to the sprint's project. Honors " +
        'the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runMoveToSprint(args, resolveContext(extra)),
  );
}
