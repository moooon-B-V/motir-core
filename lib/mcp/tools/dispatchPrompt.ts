import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import {
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isSelfBlockingDesignAdvisory,
  isSizingAdvisory,
  isSubsumptionAdvisory,
} from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { dispatchPromptPayload, presentMcpDispatchPrompt } from '../payloads/workLoop';
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
  const references = dto.advisories.filter(isReferenceAdvisory);
  const shapes = dto.advisories.filter(isOrderingAdvisory);
  const straddles = dto.advisories.filter(isRepoStraddleAdvisory);
  const subsumed = dto.advisories.filter(isSubsumptionAdvisory);
  const oversized = dto.advisories.filter(isSizingAdvisory);
  const selfBlocking = dto.advisories.filter(isSelfBlockingDesignAdvisory);
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
  for (const s of straddles) {
    lines.push(
      `Advisory (NOT a blocker — ${dto.key} still dispatches): acceptance criterion ` +
        `${s.criterionIndex} names ${s.path}, which lives in ${s.repo}` +
        (s.reason === 'contradiction'
          ? " — not this card's pinned repo."
          : ', and this card pins no repo while its criteria name more than one.') +
        ' One subtask, one repo, one PR — check the other repo before branching.',
    );
  }
  // THE ESTIMATION GATE (MOTIR-3110).
  for (const s of oversized) {
    lines.push(
      `Advisory (NOT a blocker — ${dto.key} still dispatches): it is sized ` +
        `${s.storyPoints ?? '—'} story points / ${s.estimateMinutes ?? '—'} estimated minutes, ` +
        'over the estimation gate (13+ points is the SPLIT signal; a coding_agent run must fit ' +
        'in 60 minutes). Split it before starting.',
    );
  }
  // THE DESIGN GATE (MOTIR-3178).
  for (const d of selfBlocking) {
    lines.push(
      `Advisory (NOT a blocker — ${dto.key} still dispatches): it is its OWN design blocker — ` +
        `criterion ${d.designCriterionIndex} produces a design asset and criterion ` +
        `${d.surfaceCriterionIndex} builds the surface that drawing decides. Design before code, ` +
        'within every story: lift the design criterion onto its own card rather than drawing and ' +
        'building in one pull request.',
    );
  }
  // The SUBSUMPTION advisory (MOTIR-2903).
  for (const s of subsumed) {
    lines.push(
      `Advisory (NOT a blocker — ${dto.key} still dispatches): its body names ${s.path}, which ` +
        `${s.pullRequest} already changed (merged ${s.mergedAt}). This card may already be ` +
        'built — read that diff against its acceptance criteria before writing a line.',
    );
  }
  return lines;
}

/**
 * The `Repo:` line. A card carrying MORE THAN ONE repository names every one of
 * them, in set order with the primary first, each with its delivery state
 * (MOTIR-3131) — because a reader told only the primary cannot tell a fresh card
 * from one whose other half already merged, and the completion gate holds the
 * card until every repository has.
 *
 * BYTE-IDENTICAL for a card with one repository or none: those are the shapes
 * every existing caller and test reads, and this card changes the envelope, not
 * what a single-repository dispatch looks like.
 */
function repoLine(dto: DispatchPromptDto): string {
  if (dto.targetRepos.length <= 1) {
    return `Repo: ${dto.targetRepo ?? 'not pinned (Motir cannot say)'}`;
  }
  const named = dto.targetRepos
    .map((r, i) => `${r.name}${i === 0 ? ' (primary)' : ''}${r.delivery ? ` — ${r.delivery}` : ''}`)
    .join(', ');
  return `Repos (${dto.targetRepos.length}): ${named}`;
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
    repoLine(dto),
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
  return toolOk(summarize(dto), derived(dispatchPromptPayload, presentMcpDispatchPrompt(dto)));
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
        '(by identifier, e.g. "ACME-7"): the CONTEXT / WHAT TO DO / ACCEPTANCE CRITERIA / ' +
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
