import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { presentMcpWorkItem, workItemPlacementWritePayload } from '../payloads/workItems';
import type { WorkItemPlacement } from '../payloads/workItems';
import { describePlacement, readPlacement } from './placement';
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
// UNCHANGED. This tool only resolves the `<KEY>-<n>` keys to ids.
//
// FOLDERS (Story MOTIR-5310 · MOTIR-5413): a work item's placement is a
// work-item parent OR a folder, so this verb takes EXACTLY ONE of `parentKey` and
// `folderId`. `{ parentKey }` is the move above, unchanged — `moveWorkItem`
// already clears a folder when it sets a work-item parent. `{ folderId: "<id>" }`
// files the item through `fileWorkItem` (the same door the `/items` tree uses),
// and `{ folderId: null }` takes it out of its folder. Both or neither is refused
// here, naming the rule, before any read. The result carries a `placement` field
// read back off the row.

export const MOVE_TO_PARENT_TOOL_NAME = 'move_to_parent';

const inputSchema = {
  key: workItemKeyField,
  parentKey: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'The NEW parent work item identifier (e.g. "ACME-3") — must be a kind-legal, ' +
        'same-project parent, and may not be the item itself or one of its descendants. ' +
        'Pass null to promote the item to a top-level root (allowed only for kinds that ' +
        'may live at the top level; a filed item keeps its folder). Give EXACTLY ONE of ' +
        'parentKey and folderId.',
    ),
  folderId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'The id of a folder (as `list_folders` returns it) to FILE the item into, or null to ' +
        'take it OUT of its folder to the top level. Filing clears the work-item parent; the ' +
        "item's own children travel with it. Give EXACTLY ONE of parentKey and folderId. An " +
        "unknown folder is FOLDER_NOT_FOUND, another project's CROSS_PROJECT_FOLDER.",
    ),
};

interface MoveToParentArgs {
  key: string;
  parentKey?: string | null;
  folderId?: string | null;
}

/** Compact human-readable summary of a placement change. */
function summarize(dto: WorkItemDto, placement: WorkItemPlacement): string {
  return `Moved ${dto.identifier} [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${describePlacement(placement)}`;
}

/** The exactly-one-of rule, stated where the caller will read it. */
const EXACTLY_ONE_PLACEMENT =
  'move_to_parent takes EXACTLY ONE of parentKey (a work-item parent, or null for the top level) ' +
  'and folderId (a folder, or null to take the item out of its folder).';

/** The adapter: resolve the item (+ optional new parent) by key, then re-parent. */
export async function runMoveToParent(
  args: MoveToParentArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const hasParent = args.parentKey !== undefined;
  const hasFolder = args.folderId !== undefined;
  if (hasParent === hasFolder) {
    return toolError(hasParent ? 'PLACEMENT_CONFLICT' : 'INVALID_REQUEST', EXACTLY_ONE_PLACEMENT);
  }
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    if (hasFolder) {
      // File into (or out of) a folder — the `/items` tree's door. It runs the
      // edit gate, the same-project folder check and the subtask-at-root rule.
      await workItemsService.fileWorkItem(item.id, { folderId: args.folderId ?? null }, ctx);
      const filed = await workItemsService.getWorkItem(item.id, ctx);
      const placement = await readPlacement(item.id, null, ctx);
      return toolOk(
        summarize(filed, placement),
        derived(workItemPlacementWritePayload, { ...presentMcpWorkItem(filed), placement }),
      );
    }

    let newParentId: string | null = null;
    let parentKey: string | null = null;
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
      parentKey = parent.identifier;
    }

    // No `beforeId`/`afterId` → append into the new parent at a freshly-minted
    // valid position (the service's neighbor-less re-parent branch).
    const dto = await workItemsService.moveWorkItem(item.id, { newParentId }, ctx);
    const placement = await readPlacement(item.id, parentKey, ctx);
    return toolOk(
      summarize(dto, placement),
      derived(workItemPlacementWritePayload, { ...presentMcpWorkItem(dto), placement }),
    );
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
        'Change where a work item (by identifier, e.g. "ACME-7") sits. Give EXACTLY ONE of: ' +
        'parentKey — move it under a different parent (by identifier), or with null promote it to ' +
        'a top-level root; or folderId — file it into a folder (an id from list_folders), or with ' +
        'null take it out of its folder. Filing clears the work-item parent, and setting a parent ' +
        'takes the item out of its folder. The item keeps its identifier, history, comments, and ' +
        'links, and the result carries a `placement` field saying where it now sits. Honors the ' +
        'same kind-parent rules, same-project / no-cycle / depth limits, and access checks as the ' +
        "UI. Use create_work_item to place an item at creation, and update_work_item for a card's fields.",
      inputSchema,
    },
    async (args, extra) => runMoveToParent(args, resolveContext(extra)),
  );
}
