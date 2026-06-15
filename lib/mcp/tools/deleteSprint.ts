import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sprintsService } from '@/lib/services/sprintsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { sprintIdField } from './sprintRef';

// `delete_sprint` (Story 7.8 · Subtask 7.8.10) — delete a planned or complete
// sprint. A thin adapter over `sprintsService.deleteSprint`: the service's
// guards apply unchanged — the ACTIVE sprint cannot be deleted (complete it
// instead → CannotDeleteActiveSprintError), and a deleted sprint's issues are
// NEVER deleted (the `sprint_id` FK is SetNull, so they fall back to the
// backlog in their existing order). Destructive, so the tool description states
// exactly what the service does before an agent reaches for it.

export const DELETE_SPRINT_TOOL_NAME = 'delete_sprint';

const inputSchema = {
  sprintId: sprintIdField,
};

/** The adapter: delete the sprint, then confirm. */
export async function runDeleteSprint(
  args: { sprintId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    await sprintsService.deleteSprint(args.sprintId, ctx);
    return toolOk(`Deleted sprint ${args.sprintId}. Its issues fell back to the backlog.`, {
      sprintId: args.sprintId,
      deleted: true,
    });
  } catch (err) {
    return toToolError(err);
  }
}

export function registerDeleteSprint(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    DELETE_SPRINT_TOOL_NAME,
    {
      title: 'Delete sprint',
      description:
        'Delete a planned or complete sprint (by id). Its issues are NOT deleted — they fall ' +
        'back to the backlog in their existing order. The ACTIVE sprint cannot be deleted; ' +
        'complete it instead. Requires sprint-admin permission.',
      inputSchema,
    },
    async (args, extra) => runDeleteSprint(args, resolveContext(extra)),
  );
}
