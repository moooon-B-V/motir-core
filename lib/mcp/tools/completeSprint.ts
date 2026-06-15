import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sprintsService } from '@/lib/services/sprintsService';
import type { CarryOverDestination, CompleteSprintInput } from '@/lib/dto/sprints';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { sprintIdField, summarizeSprint } from './sprintRef';

// `complete_sprint` (Story 7.8 · Subtask 7.8.10) — close out an active sprint.
// A thin adapter over `sprintsService.completeSprint`: the one-way state machine
// (only an active sprint is completable), the done-issues-stay / unfinished-
// issues-carry-over split, the report snapshot, and the carry-over target
// validation all run in the service unchanged.
//
// The carry-over DISPOSITION is REQUIRED at the schema level (no default), so
// an agent must STATE where unfinished issues go — either back to the
// `"backlog"` or into a `{ sprintId }` of another planned same-project sprint —
// rather than silently inheriting the service's `'backlog'` default. This
// mirrors the UI's complete-sprint modal, which forces the choice.

export const COMPLETE_SPRINT_TOOL_NAME = 'complete_sprint';

const inputSchema = {
  sprintId: sprintIdField,
  carryOverTo: z
    .union([z.literal('backlog'), z.object({ sprintId: z.string().min(1) })])
    .describe(
      'REQUIRED disposition for unfinished items: "backlog" (move them to the backlog) or ' +
        '{ "sprintId": "<id>" } to move them into another PLANNED sprint in the same project. ' +
        'Done items always stay on the completed sprint.',
    ),
};

interface CompleteSprintArgs {
  sprintId: string;
  carryOverTo: CarryOverDestination;
}

/** The adapter: forward the disposition to the service. */
export async function runCompleteSprint(
  args: CompleteSprintArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const input: CompleteSprintInput = { carryOverTo: args.carryOverTo };
    const dto = await sprintsService.completeSprint(args.sprintId, input, ctx);
    const where =
      args.carryOverTo === 'backlog' ? 'the backlog' : `sprint ${args.carryOverTo.sprintId}`;
    return toolOk(
      `Completed ${summarizeSprint(dto)} (unfinished items → ${where})`,
      dto as unknown as Record<string, unknown>,
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCompleteSprint(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    COMPLETE_SPRINT_TOOL_NAME,
    {
      title: 'Complete sprint',
      description:
        'Complete an active sprint (by id). You MUST state where unfinished items go via ' +
        'carryOverTo: "backlog", or { sprintId } of another planned sprint in the same project. ' +
        'Done items stay on the completed sprint as its record. Requires sprint-admin permission.',
      inputSchema,
    },
    async (args, extra) => runCompleteSprint(args, resolveContext(extra)),
  );
}
