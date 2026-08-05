import { z } from 'zod';
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

/**
 * A git ref name, restricted to the characters a branch may safely carry here.
 * The seed is INTERPOLATED INTO PROMPT TEXT that instructs an agent to run
 * `git ... origin/<branch>`, so a name containing whitespace, a shell
 * metacharacter, or a leading `-` would be a command the agent might run on the
 * caller's behalf. Refusing those is cheaper than escaping them, and every real
 * branch name passes.
 */
const SEED_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

const inputSchema = {
  key: workItemKeyField,
  sessionBranch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(SEED_BRANCH_PATTERN, 'Not a safe branch name.')
    .optional()
    .describe(
      'Optional session branch to FALL BACK to when this item carries no lineage of ' +
        'its own — the unattended-run seed (`motir auto`). It never overrides: an item ' +
        'whose dependencies are already integrated, or that is itself integrated, keeps ' +
        'that branch, so a caller cannot redirect a live lineage.',
    ),
};

/**
 * The advisory one-liners, one per family (MOTIR-2079 + MOTIR-2175). Both are
 * already rendered INSIDE the prompt; repeating them at the top is what makes a
 * caller who skims the summary see them at all.
 */
function advisorySummary(dto: DispatchPromptDto): string[] {
  const references = dto.advisories.filter((a) => a.kind !== 'shape');
  const shapes = dto.advisories.filter((a) => a.kind === 'shape');
  const lines: string[] = [];
  if (references.length > 0) {
    lines.push(
      `Advisory (NOT a blocker — ${dto.key} still dispatches): its acceptance criteria ` +
        `name ${references.map((a) => `${a.referenced} (${a.referencedStatus})`).join(', ')} ` +
        'with no blocked_by edge. Verify each is on origin/main before branching.',
    );
  }
  for (const s of shapes) {
    lines.push(
      `Advisory (NOT a blocker — ${dto.key} still dispatches): acceptance criterion ` +
        `${s.criterionIndex} says "${s.phrase}", state that exists only after this card's own ` +
        'PR has merged. Cut the card there — the remainder belongs to a follow-on card.',
    );
  }
  return lines;
}

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
    // The advisory is inside the prompt already; naming it up here is what makes
    // a caller that skims the summary see it (MOTIR-2079 — the whole incident was
    // a signal that was emitted correctly and read by nobody).
    ...advisorySummary(dto),
    '',
    dto.prompt,
  ].join('\n');
}

/** The adapter: resolve the project from the key prefix, assemble the prompt. */
export async function runDispatchPrompt(
  args: { key: string; sessionBranch?: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  const dto = await dispatchPromptService.getDispatchPrompt(project.id, identifier, ctx, {
    sessionBranch: args.sessionBranch ?? null,
  });
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
        'it is the same text for every agent by design. Pass sessionBranch only to seed an ' +
        'unattended run: it applies solely when the item has no lineage of its own.',
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
