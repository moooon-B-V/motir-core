import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sprintsService } from '@/lib/services/sprintsService';
import type { StartSprintInput } from '@/lib/dto/sprints';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { sprintIdField, summarizeSprint } from './sprintRef';

// `start_sprint` (Story 7.8 · Subtask 7.8.10) — activate a planned sprint. A
// thin adapter over `sprintsService.startSprint`: the one-way state machine
// (only a planned sprint is startable), the one-active-per-project guard, the
// scope-lock baseline snapshot, the window validation, and the optional
// rename/re-goal-on-start all run in the service unchanged. Completeness
// requires it — an agent that can create and complete a sprint but not START
// one has a hole in the middle of the lifecycle.

export const START_SPRINT_TOOL_NAME = 'start_sprint';

const inputSchema = {
  sprintId: sprintIdField,
  name: z.string().optional().describe('Optional rename on start.'),
  goal: z
    .string()
    .nullable()
    .optional()
    .describe('Optional goal edit on start; null clears it, omit to leave unchanged.'),
  startDate: z.string().optional().describe('Optional start (ISO-8601); defaults to now.'),
  endDate: z.string().optional().describe('Optional planned end (ISO-8601); must be ≥ startDate.'),
};

interface StartSprintArgs {
  sprintId: string;
  name?: string;
  goal?: string | null;
  startDate?: string;
  endDate?: string;
}

/** The adapter: forward the start input to the service. */
export async function runStartSprint(
  args: StartSprintArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const input: StartSprintInput = {
      name: args.name,
      goal: args.goal,
      startDate: args.startDate,
      endDate: args.endDate,
    };
    const dto = await sprintsService.startSprint(args.sprintId, input, ctx);
    return toolOk(`Started ${summarizeSprint(dto)}`, dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerStartSprint(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    START_SPRINT_TOOL_NAME,
    {
      title: 'Start sprint',
      description:
        'Start a planned sprint (by id), making it active. A project can have only one active ' +
        'sprint at a time; only a planned sprint is startable. Optionally rename/re-goal and set ' +
        'the window on start. Requires sprint-admin permission.',
      inputSchema,
    },
    async (args, extra) => runStartSprint(args, resolveContext(extra)),
  );
}
