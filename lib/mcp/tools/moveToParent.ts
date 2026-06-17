import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `move_to_parent` (Story 7.8 · bug 7.8 MOTIR-1017) — RE-PARENT an existing work
// item: move it under a different parent, or promote it to a top-level root.
// This closes the one structural move the agent surface still lacked:
// `create_work_item` can only set the parent AT CREATE (`parentKey`), and
// `update_work_item` deliberately omits it ("a structural move, not a field
// edit"), so an agent had no way to re-home a card short of delete-and-recreate
// — which loses the identifier, history, comments, and links. Re-parenting is
// its OWN verb here for the same reason status (`transition_status`) and sprint
// membership (`move_to_sprint` / `move_to_backlog`) are: a structural move, not
// a field patch.
//
// A THIN adapter over `workItemsService.moveWorkItem` — the SAME service method
// the tree/board UI re-parent uses. We pass `newParentId` with NO neighbor ids,
// so the service mints a valid fractional position appended into the new parent
// (a bare `updateWorkItem({ parentId })` would leave the old sibling-set
// position behind, which doesn't sort among the new siblings). The kind-parent
// matrix (`assertValidParent`), the same-project guard (`CrossProjectParentError`),
// the cycle/depth DB-trigger backstop (→ `ParentCycleError` / `DepthLimitExceededError`),
// the 6.4 edit gate, and the `parentId` revision all run in the service
// UNCHANGED. This tool only resolves the `PROD-<n>` keys to ids.

export const MOVE_TO_PARENT_TOOL_NAME = 'move_to_parent';

const inputSchema = {
  key: workItemKeyField,
  parentKey: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'The NEW parent work item identifier (e.g. "PROD-3") — must be a kind-legal, ' +
        'same-project parent, and may not be the item itself or one of its descendants. ' +
        'Pass null to promote the item to a top-level root (allowed only for kinds that ' +
        'may live at the top level).',
    ),
};

interface MoveToParentArgs {
  key: string;
  parentKey: string | null;
}

/** Compact human-readable summary of a re-parent. */
function summarize(dto: WorkItemDto): string {
  const where = dto.parentId ? `under ${dto.parentId}` : 'to the top level';
  return `Moved ${dto.identifier} [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${where}`;
}

/** The adapter: resolve the item (+ optional new parent) by key, then re-parent. */
export async function runMoveToParent(
  args: MoveToParentArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    let newParentId: string | null = null;
    if (args.parentKey != null && args.parentKey.trim() !== '') {
      // The new parent must be in the SAME project (the service re-checks
      // same-project + kind-legality + cycle/depth). Resolve it within the
      // item's project; a foreign/unknown parent identifier 404s here as
      // WorkItemNotFoundError (the 404-not-403 contract, no existence leak).
      const parent = await workItemsService.getWorkItemByIdentifier(
        project.id,
        normalizeIdentifier(args.parentKey),
        ctx,
      );
      newParentId = parent.id;
    }

    // No `beforeId`/`afterId` → append into the new parent at a freshly-minted
    // valid position (the service's neighbor-less re-parent branch).
    const dto = await workItemsService.moveWorkItem(item.id, { newParentId }, ctx);
    return toolOk(summarize(dto), dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerMoveToParent(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    MOVE_TO_PARENT_TOOL_NAME,
    {
      title: 'Move work item to a new parent',
      description:
        'Re-parent a work item (by identifier, e.g. "PROD-7"): move it under a different parent ' +
        '(by identifier) or, with parentKey null, promote it to a top-level root. The item keeps ' +
        'its identifier, history, comments, and links. Honors the same kind-parent rules, ' +
        'same-project / no-cycle / depth limits, and access checks as the UI. Use create_work_item ' +
        "to set a parent at creation, and update_work_item for a card's fields.",
      inputSchema,
    },
    async (args, extra) => runMoveToParent(args, resolveContext(extra)),
  );
}
