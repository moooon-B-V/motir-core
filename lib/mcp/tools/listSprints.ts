import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { unmigrated } from '../payloads/define';
import { projectKeyField, summarizeSprint } from './sprintRef';

// `list_sprints` (Story 7.8 · Subtask 7.8.10) — the read an agent runs BEFORE
// it can target any other sprint tool: it returns each sprint's id (the handle
// the other tools take), name, state, goal, window, and issue count. A thin
// adapter over `sprintsService.listByProject` (sprints in `sequence` order,
// each with its committed-issue count) — no business logic, the same access
// checks as the UI (a member read; the workspace gate makes a foreign project
// an empty list, never another tenant's sprints).

export const LIST_SPRINTS_TOOL_NAME = 'list_sprints';

const inputSchema = {
  projectKey: projectKeyField,
};

/** The adapter: resolve the project by key, then list its sprints. */
export async function runListSprints(
  args: { projectKey: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const sprints = await sprintsService.listByProject(project.id, ctx);
    const text =
      sprints.length === 0
        ? `No sprints in ${project.identifier}.`
        : sprints.map((s) => summarizeSprint(s)).join('\n');
    // Dual content: the text block for a human, the array under `sprints` for
    // the agent (structuredContent must be an object, so the list is wrapped).
    //
    // Built through `toolOk` since MOTIR-2228. It was the ONE tool that assembled
    // its own result, which made it the one tool the totality mechanism could not
    // see — and a mechanism with a single invisible member is not a mechanism
    // (ADR Amendment 7 Q4). It is not exempt: a sprint collection has a v1
    // counterpart, so it derives with its family in MOTIR-2230.
    return toolOk(text, unmigrated('list_sprints', { sprints }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerListSprints(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_SPRINTS_TOOL_NAME,
    {
      title: 'List sprints',
      description:
        "List a project's sprints (by project key) with each sprint's id, name, state (planned " +
        '/ active / complete), goal, window, and issue count. Use the returned id to target the ' +
        'other sprint tools. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runListSprints(args, resolveContext(extra)),
  );
}
