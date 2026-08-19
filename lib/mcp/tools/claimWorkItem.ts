import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemClaimDto } from '@/lib/dto/claim';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { claimWorkItemPayload, presentMcpWorkItemClaim } from '../payloads/workItems';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `claim_work_item` (MOTIR-2961) — the ATOMIC claim of ONE NAMED work item.
//
// The counterpart of `claim_next_ready`, for the caller that was HANDED a card
// rather than asking for whatever is next. `claim_next_ready` locks the
// best-ranked candidate `FOR UPDATE SKIP LOCKED`; this locks the one row it was
// given, `FOR UPDATE` and BLOCKING, because there is no next-best to fall to and
// a loser must observe the winner's committed write in order to name them.
//
// ⚠️ A SECOND CALLER, NEVER A SECOND IMPLEMENTATION. The v1 route
// (`POST /api/v1/work-items/{key}/claim`) is the deliverable — it is what the
// CLI speaks since 11.5.6 retired its MCP transport. Both surfaces call
// `workItemsService.claimWorkItem`, so there is exactly one lock and one
// vocabulary. This tool exists because the RUNBOOK path — a planner agent told
// to run a specific card — reaches Motir over MCP, and that is precisely the
// path MOTIR-2958 caught starting the same card twice.
//
// ⚠️ THE CLAIM IS THE DISPATCH FLIP. Do NOT call `transition_status` after it.

export const CLAIM_WORK_ITEM_TOOL_NAME = 'claim_work_item';

const inputSchema = {
  key: workItemKeyField,
};

/** What the agent reads first — the outcome, said as an instruction. */
function summarize(claim: WorkItemClaimDto): string {
  const holder = claim.assignee?.name ?? claim.transitionedBy?.name ?? 'someone else';
  switch (claim.outcome) {
    case 'claimed':
      return (
        `Claimed (now In Progress, assigned to you): ${claim.key} — ${claim.title}. ` +
        'The claim IS the dispatch status flip; do NOT call transition_status. ' +
        '⚠️ A server-side claim cannot see a working tree a crashed session left behind — ' +
        'check the disk before you branch.'
      );
    case 'mine':
      return (
        `Already yours: ${claim.key} is In Progress and assigned to you — this is a RESUME of ` +
        'your own interrupted run, not a lost race. Proceed, and check what is already ' +
        'committed on its branch before you redo anything.'
      );
    case 'taken':
      return (
        `NOT claimed: ${claim.key} is In Progress and held by ${holder}` +
        (claim.transitionedAt ? ` (since ${claim.transitionedAt})` : '') +
        '. Another session is working it. Do NOT start — pick different work.'
      );
    case 'not_claimable':
      return (
        `NOT claimed: ${claim.key} is at "${claim.status.key}", outside the to-do category, so ` +
        'it is not available to a run at all. A finished or in-review card is not work to ' +
        'start; if you believe it should be re-opened, that is a decision for a person.'
      );
  }
}

/** The adapter: resolve the project from the key, then claim through the service. */
export async function runClaimWorkItem(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const claim = await workItemsService.claimWorkItem(project.id, identifier, ctx);
    return toolOk(summarize(claim), derived(claimWorkItemPayload, presentMcpWorkItemClaim(claim)));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerClaimWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CLAIM_WORK_ITEM_TOOL_NAME,
    {
      title: 'Claim a work item',
      description:
        'ATOMICALLY claim ONE work item by identifier (e.g. "ACME-7") for dispatch: in a single ' +
        'transaction the row is locked, its status is re-checked against the TO-DO category ' +
        '(`todo` AND `blocked`, so a forced dispatch of a blocked card still works), and — if ' +
        'that holds — the item is assigned to you and moved to "In progress". Use this whenever ' +
        'you were handed a specific card to run; use `claim_next_ready` when you want whatever ' +
        'is next. The claim IS the dispatch status flip — do NOT also call `transition_status`. ' +
        'A refusal is a RESULT, not an error, and it says which: `claimed` (yours now), `mine` ' +
        '(already In Progress and yours — resume your own interrupted run), `taken` (someone ' +
        'else holds it, and they are named), `not_claimable` (In Review / Done / Cancelled / ' +
        'Planning / Implemented or archived — never re-opened by a claim). Honors the same ' +
        'access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runClaimWorkItem(args, resolveContext(extra)),
  );
}
