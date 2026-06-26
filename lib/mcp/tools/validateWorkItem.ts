import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemValidityDto } from '@/lib/dto/workItems';
import type { ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { conditionField } from './sprintRef';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `validate_work_item` (Story 7.8 · Subtask 7.8.23) — is a work item FINISHABLE?
// The single-item analogue of `validate_sprint`, with the target's SUBTREE
// (the item + all its descendants) standing in for the sprint. The target may
// be any non-leaf kind — epic / story / task / bug. VALID ⟺ every not-done item
// in the subtree has its `blocked_by` closure satisfied: each dependency is IN
// the subtree (the target's own work — never gates), or — under `loose` — done.
//
// `condition` (shared with `validate_sprint`, MOTIR-1374) tunes the
// out-of-subtree `done` case: `loose` (default) accepts a done dependency
// anywhere; `tight` requires it to be IN the subtree, else it is reported.
//
// A thin READ adapter over `workItemsService.validateWorkItem` — no business
// logic here; the subtree walk + the validity rule live in the service. READ
// scope (`lib/mcp/scopes.ts`), like `validate_sprint` / `get_work_item`.

export const VALIDATE_WORK_ITEM_TOOL_NAME = 'validate_work_item';

const inputSchema = {
  key: workItemKeyField,
  condition: conditionField,
};

interface ValidateWorkItemArgs {
  key: string;
  condition?: ValidityCondition;
}

/** Human-readable summary for the dual-content text block. */
function summarize(result: WorkItemValidityDto): string {
  if (result.valid) {
    return `Work item ${result.key} is VALID — its whole subtree can be finished within itself.`;
  }
  return [
    `Work item ${result.key} is INVALID — ${result.blockers.length} item(s) in its subtree are ` +
      'gated by out-of-subtree, unsatisfied work:',
    ...result.blockers.map(
      (b) =>
        `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
        `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
    ),
    'Pull these into the subtree (or finish them), or drop the dependency.',
  ].join('\n');
}

export async function runValidateWorkItem(
  args: ValidateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    // `conditionField` fills the default (`loose`) when omitted, and the service
    // param defaults too — so no `??` here (it would add a never-taken branch).
    const result = await workItemsService.validateWorkItem(
      project.id,
      identifier,
      ctx,
      args.condition,
    );
    return toolOk(summarize(result), result as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerValidateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    VALIDATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Validate work-item finishability',
      description:
        'Check whether a work item (any non-leaf kind — epic / story / task / bug) is FINISHABLE: ' +
        'every not-done item in its SUBTREE (the item + all descendants) has each blocked_by ' +
        'dependency either inside the subtree (its own work) or done. A blocker inside the subtree ' +
        'never gates; only out-of-subtree work can. `condition` defaults to `loose` (a done ' +
        'dependency outside the subtree counts as satisfied); pass `tight` to require every ' +
        'dependency to be IN the subtree (a done item outside it is then reported as a blocker). ' +
        'Returns `{ key, valid, blockers: [...] }` naming each in-subtree item and the ' +
        'out-of-subtree, unsatisfied work gating it. Read-only.',
      inputSchema,
    },
    async (args, extra) => runValidateWorkItem(args, resolveContext(extra)),
  );
}
