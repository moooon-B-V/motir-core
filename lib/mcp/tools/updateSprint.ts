import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sprintsService } from '@/lib/services/sprintsService';
import type { UpdateSprintInput } from '@/lib/dto/sprints';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { sprintIdField, summarizeSprint } from './sprintRef';

// `update_sprint` (Story 7.8 · Subtask 7.8.10) — the "sprint settings" tool:
// rename, re-goal, or re-date a sprint. A thin adapter over
// `sprintsService.updateSprint` — the service's own state rules decide what is
// editable (a complete sprint is frozen → CannotModifyCompletedSprintError; an
// active sprint's goal/window may still be edited), surfaced verbatim as typed
// tool errors. An omitted field is left unchanged; an explicit null clears the
// goal or a date.

export const UPDATE_SPRINT_TOOL_NAME = 'update_sprint';

const inputSchema = {
  sprintId: sprintIdField,
  name: z.string().optional().describe('New name (omit to leave unchanged).'),
  goal: z
    .string()
    .nullable()
    .optional()
    .describe('New goal; null clears it, omit to leave unchanged.'),
  startDate: z
    .string()
    .nullable()
    .optional()
    .describe('New planned start (ISO-8601); null clears it, omit to leave unchanged.'),
  endDate: z
    .string()
    .nullable()
    .optional()
    .describe('New planned end (ISO-8601, ≥ startDate); null clears it, omit to leave unchanged.'),
};

interface UpdateSprintArgs {
  sprintId: string;
  name?: string;
  goal?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

/** The adapter: forward the patch to the service (undefined = unchanged). */
export async function runUpdateSprint(
  args: UpdateSprintArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const patch: UpdateSprintInput = {
      name: args.name,
      goal: args.goal,
      startDate: args.startDate,
      endDate: args.endDate,
    };
    const dto = await sprintsService.updateSprint(args.sprintId, patch, ctx);
    return toolOk(`Updated ${summarizeSprint(dto)}`, dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerUpdateSprint(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    UPDATE_SPRINT_TOOL_NAME,
    {
      title: 'Update sprint',
      description:
        'Update a sprint (by id): rename, change the goal, or adjust the planned window. A ' +
        'completed sprint cannot be edited; an active sprint can still have its goal/window ' +
        'changed. Omit a field to leave it unchanged; pass null to clear the goal or a date. ' +
        'Requires sprint-admin permission.',
      inputSchema,
    },
    async (args, extra) => runUpdateSprint(args, resolveContext(extra)),
  );
}
