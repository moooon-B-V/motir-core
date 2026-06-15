import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import {
  normalizeIdentifier,
  projectKeyOf,
  sessionBranchField,
  workItemKeyField,
} from './workItemRef';

// `mark_integrated` (Story 7.8 · Subtask 7.8.11) — record that a work item's
// work has been integrated onto a session branch. The write the 7.9 CLI loop
// calls on agent success: it moves the item to `in_review` AND stamps its
// `session_branch` in ONE transaction, so the item is "integrated-awaiting-
// review" — done enough to UNBLOCK its dependents (the field-keyed readiness
// rule), but not yet merged to main. A thin adapter over
// `workItemsService.markIntegrated`; the workflow legal-transition validation
// decides whether the move to `in_review` is allowed (an item that can't reach
// it surfaces `IllegalTransitionError`, field untouched). No business logic here.

export const MARK_INTEGRATED_TOOL_NAME = 'mark_integrated';

const inputSchema = {
  key: workItemKeyField,
  sessionBranch: sessionBranchField,
};

/** The adapter: resolve project + item by key, then mark it integrated. */
export async function runMarkIntegrated(
  args: { key: string; sessionBranch: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    const dto: WorkItemDto = await workItemsService.markIntegrated(
      item.id,
      args.sessionBranch,
      ctx,
    );
    return toolOk(
      `${dto.identifier}: integrated on "${dto.sessionBranch}" (status ${dto.status})`,
      dto as unknown as Record<string, unknown>,
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerMarkIntegrated(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    MARK_INTEGRATED_TOOL_NAME,
    {
      title: 'Mark integrated',
      description:
        'Record that a work item (by identifier, e.g. "PROD-7") has been integrated onto a ' +
        'session branch: it moves to "In review" and records the branch, which unblocks its ' +
        'dependents while the session PR awaits a human merge. Honors the workflow rules and ' +
        'the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runMarkIntegrated(args, resolveContext(extra)),
  );
}
