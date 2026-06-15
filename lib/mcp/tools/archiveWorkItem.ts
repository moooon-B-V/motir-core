import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `archive_work_item` / `unarchive_work_item` (Story 7.8 · Subtask 7.8.14) — the
// SOFT-REMOVE pair, the agent surface for Jira's archive + restore. Before this
// the only way to take a mistaken card out of the ready set was the
// `transition_status → cancelled` hack; archive is the real soft-delete (stamps
// `archivedAt`, drops the item from `list_ready` / search), and unarchive
// restores it.
//
// Both are THIN adapters over the shipped services — `archiveWorkItem` /
// `unarchiveWorkItem` — so every invariant holds unchanged: the tenant gate,
// the 6.4 edit gate, the revision row, and the SINGLE-ITEM scope (archive does
// NOT cascade to children — the deliberate "Linear shape"; a destructive subtree
// delete is the separate, explicit `delete_work_item` of Story 2.8). A PERMANENT
// hard delete is NOT here — archive is reversible by design.

export const ARCHIVE_WORK_ITEM_TOOL_NAME = 'archive_work_item';
export const UNARCHIVE_WORK_ITEM_TOOL_NAME = 'unarchive_work_item';

const inputSchema = {
  key: workItemKeyField,
};

interface ArchiveArgs {
  key: string;
}

/** Resolve a `PROD-<n>` key to its work-item id within its own project. */
async function resolveItemId(key: string, ctx: ServiceContext): Promise<string> {
  const identifier = normalizeIdentifier(key);
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
  return item.id;
}

/** The archive adapter: resolve by key, soft-delete (stamp archivedAt). */
export async function runArchiveWorkItem(
  args: ArchiveArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const id = await resolveItemId(args.key, ctx);
    const dto: WorkItemDto = await workItemsService.archiveWorkItem(id, ctx);
    return toolOk(
      `Archived ${dto.identifier} — ${dto.title} (removed from the ready set; children left intact).`,
      dto as unknown as Record<string, unknown>,
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** The unarchive adapter: resolve by key, restore (clear archivedAt). */
export async function runUnarchiveWorkItem(
  args: ArchiveArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const id = await resolveItemId(args.key, ctx);
    const dto: WorkItemDto = await workItemsService.unarchiveWorkItem(id, ctx);
    return toolOk(
      `Restored ${dto.identifier} — ${dto.title} (back in active views).`,
      dto as unknown as Record<string, unknown>,
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerArchiveWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    ARCHIVE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Archive work item',
      description:
        'Soft-delete (archive) a work item by identifier (e.g. "PROD-7"): it leaves the ready ' +
        'set and search but is fully recoverable with unarchive_work_item. Archives only this ' +
        'item — children are left intact. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runArchiveWorkItem(args, resolveContext(extra)),
  );
  server.registerTool(
    UNARCHIVE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Unarchive work item',
      description:
        'Restore an archived work item by identifier (e.g. "PROD-7") — the inverse of ' +
        'archive_work_item; it returns to active views. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runUnarchiveWorkItem(args, resolveContext(extra)),
  );
}
