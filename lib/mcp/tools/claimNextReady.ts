import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReadyItemDispatchDto } from '@/lib/dto/ready';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { projectKeyField } from './readyFilters';

// `claim_next_ready` (MOTIR-1330) — ATOMIC, race-safe dispatch claim. Unlike
// `next_ready` (which READS the top ready item without changing it), this CLAIMS:
// it locks the highest-ranked ready Subtask (`FOR UPDATE SKIP LOCKED`), flips it
// to `in_progress`, and returns the same dispatch payload — all in one
// transaction. Two concurrent `motir run` sessions therefore never claim the same
// item: the loser takes the next-best, or gets an empty result and RETRIES. The
// claim IS the dispatch flip, so the caller must NOT also `transition_status`
// afterwards. SCOPE: the active sprint is resolved server-side (one per project)
// and the claim is scoped to it when present; when there is NO active sprint —
// Motir used without sprint planning (plain Kanban) — the claim widens to the
// whole project, so a missing sprint is never an error. No sprint id is passed.

export const CLAIM_NEXT_READY_TOOL_NAME = 'claim_next_ready';

const inputSchema = {
  projectKey: projectKeyField,
};

interface ClaimNextReadyArgs {
  projectKey: string;
}

/** Compact summary of the claimed item. */
function summarize(item: ReadyItemDispatchDto): string {
  const lines = [
    `Claimed (now In Progress): ${item.key} [${item.kind}/${item.priority}] ${item.title}`,
    `Run: ${item.runCommand}`,
  ];
  if (item.parentKey) lines.push(`Parent: ${item.parentKey}`);
  if (item.contextRefs.length > 0) lines.push(`Context refs: ${item.contextRefs.join(', ')}`);
  if (item.descriptionMd) {
    const excerpt = item.descriptionMd.slice(0, 800);
    lines.push('', excerpt + (item.descriptionMd.length > 800 ? '…' : ''));
  }
  return lines.join('\n');
}

export async function runClaimNextReady(
  args: ClaimNextReadyArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const project = await projectsService.getByKey(args.projectKey, ctx);
  // Prefer the active sprint when one exists (sprint discipline — dispatch only
  // committed work); otherwise claim across the WHOLE project. Motir can be used
  // WITHOUT planning a sprint (plain Kanban), so a missing active sprint is NOT
  // an error — it just widens the claim to the project's ready set.
  const activeSprint = await sprintsService.getActiveSprint(project.id, ctx);
  const item = await workItemsService.claimNextReady(project.id, activeSprint?.id ?? null, ctx);
  if (!item) {
    const scope = activeSprint ? 'the active sprint' : 'this project';
    return toolOk(
      `No ready work item in ${scope} to claim — RETRY (a sibling may have just claimed the last ` +
        'one), or check there is unblocked work to start.',
      { item: null, reason: 'none_ready' },
    );
  }
  return toolOk(summarize(item), { item: item as unknown as Record<string, unknown> });
}

export function registerClaimNextReady(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CLAIM_NEXT_READY_TOOL_NAME,
    {
      title: 'Claim next ready work item',
      description:
        "ATOMICALLY claim the next ready Subtask in the project's ACTIVE sprint for dispatch: " +
        'locks the highest-ranked ready item, transitions it to In Progress, and returns the full ' +
        'dispatch payload (description, context refs, blocker keys, run command). Two concurrent ' +
        'callers never get the same item — the claim IS the status flip, so do NOT call ' +
        'transition_status afterwards. Returns an empty result (retry) when nothing is ready or no ' +
        'sprint is active.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runClaimNextReady(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
