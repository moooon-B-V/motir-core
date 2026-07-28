import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `dispatch_prompt` (Story 7.9 · MOTIR-1802) — the CANONICAL, server-generated
// coding-agent prompt for ONE work item. This is the seam the CLI's single
// dispatch (MOTIR-881) consumes: `motir next --print` prints THIS text
// byte-for-byte, so the CLI never assembles its own prompt grammar and every
// agent harness receives the identical instruction.
//
// A read, not a write: it does NOT claim the item and does NOT flip its status
// (`claim_next_ready` is the tool that does both). Printing a prompt to look at
// it must never mutate the plan.
//
// One service call, no business logic — the grammar lives in
// `lib/dispatch/promptTemplate.ts` and the state reads in
// `lib/services/dispatchPromptService.ts`, exactly like every sibling tool.

export const DISPATCH_PROMPT_TOOL_NAME = 'dispatch_prompt';

const inputSchema = {
  key: workItemKeyField,
};

/** Compact summary for the human watching the session; the prompt itself rides
 *  in `structuredContent` (it is the machine payload, and long). */
function summarize(dto: DispatchPromptDto): string {
  const workflow =
    dto.workflowMode === 'session_lineage'
      ? `session lineage on ${dto.sessionBranch}`
      : 'one pull request of its own';
  return [
    `Dispatch prompt for ${dto.key}`,
    `Repo: ${dto.targetRepo ?? 'not pinned (Motir cannot say)'}`,
    `Git workflow: ${workflow}`,
    '',
    dto.prompt,
  ].join('\n');
}

/** The adapter: resolve the project from the key prefix, assemble the prompt. */
export async function runDispatchPrompt(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  const dto = await dispatchPromptService.getDispatchPrompt(project.id, identifier, ctx);
  return toolOk(summarize(dto), dto as unknown as Record<string, unknown>);
}

export function registerDispatchPrompt(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    DISPATCH_PROMPT_TOOL_NAME,
    {
      title: 'Dispatch prompt',
      description:
        'Return the canonical, server-generated coding-agent prompt for one work item ' +
        '(by identifier, e.g. "PROD-7"): the CONTEXT / WHAT TO DO / ACCEPTANCE CRITERIA / ' +
        'GIT WORKFLOW sections assembled from the item, its parent, its dependencies and ' +
        'its repo, plus the repo to run it in and which git workflow it carries. A pure ' +
        'read — it does NOT claim the item or change its status. Do not rewrite the prompt: ' +
        'it is the same text for every agent by design.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runDispatchPrompt(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
