import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import type { CreateSprintInput } from '@/lib/dto/sprints';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { projectKeyField, summarizeSprint } from './sprintRef';

// `create_sprint` (Story 7.8 · Subtask 7.8.10) — create a PLANNED sprint on a
// project. A thin adapter over `sprintsService.createSprint`: the owner gate,
// the `"Sprint <n>"` default name, the sequence stamp, and the date-window
// validation all run in the service unchanged. The sprint starts empty; scope
// it with `move_to_sprint`, then `start_sprint`.

export const CREATE_SPRINT_TOOL_NAME = 'create_sprint';

const inputSchema = {
  projectKey: projectKeyField,
  name: z
    .string()
    .optional()
    .describe('Optional sprint name; defaults to "Sprint <n>" (the next sequence).'),
  goal: z.string().optional().describe('Optional sprint goal.'),
  startDate: z
    .string()
    .optional()
    .describe('Optional planned start (ISO-8601). A planned sprint activates on start_sprint.'),
  endDate: z.string().optional().describe('Optional planned end (ISO-8601); must be ≥ startDate.'),
};

interface CreateSprintArgs {
  projectKey: string;
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
}

/** The adapter: resolve the project by key, then create the planned sprint. */
export async function runCreateSprint(
  args: CreateSprintArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const input: CreateSprintInput = {
      name: args.name,
      goal: args.goal,
      startDate: args.startDate,
      endDate: args.endDate,
    };
    const dto = await sprintsService.createSprint(project.id, input, ctx);
    return toolOk(`Created ${summarizeSprint(dto)}`, dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCreateSprint(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CREATE_SPRINT_TOOL_NAME,
    {
      title: 'Create sprint',
      description:
        'Create a planned sprint on a project (by project key), optionally with a name, goal, ' +
        'and planned start/end dates. The sprint starts empty and planned — scope it with ' +
        'move_to_sprint, then start_sprint. Requires sprint-admin permission.',
      inputSchema,
    },
    async (args, extra) => runCreateSprint(args, resolveContext(extra)),
  );
}
