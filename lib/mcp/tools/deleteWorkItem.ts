import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDeletePreviewDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `delete_work_item` (Story 2.8 · Subtask 2.8.5) — the PERMANENT, irreversible
// counterpart of `archive_work_item`, the agent surface for Jira's "Delete"
// (Story 2.8). A thin adapter over the shipped 2.8.2 `deleteWorkItem` service:
// the item AND its whole subtree are removed in one transaction (root + every
// descendant; links / comments / revisions cascade at the DB layer), gated on
// the SAME project-admin "manage" capability the `DELETE /api/work-items/[id]`
// route requires, and tenant-gated identically (a missing / cross-workspace key
// is a 404 `WorkItemNotFoundError`, no existence leak).
//
// ── archive vs delete. ─────────────────────────────────────────────────────
// `archive_work_item` is the REVERSIBLE soft-remove (stamps `archivedAt`, single
// item, restorable via `unarchive_work_item`). `delete_work_item` is the
// PERMANENT hard delete WITH a parent→subtree cascade — there is no undo. They
// are the two distinct removals Jira ships; an agent picks archive to take a
// card out of the ready set recoverably, delete to erase a mistaken subtree.
//
// ── The result. ────────────────────────────────────────────────────────────
// The 2.8.2 service returns `void` (the rows are gone, there is no DTO to map),
// so the deletion SUMMARY is captured from `getDeletePreview` (the 2.8.7 read)
// taken BEFORE the destructive write, while the subtree still exists: the root's
// identity plus the cascade magnitude (`totalCount` removed, `descendantCount`,
// and the per-kind descendant breakdown). Both the preview read and the delete
// run the same manage gate, so a denial surfaces as a typed error from the first
// call and the destructive write never runs.

export const DELETE_WORK_ITEM_TOOL_NAME = 'delete_work_item';

const inputSchema = {
  key: workItemKeyField,
};

interface DeleteArgs {
  key: string;
}

/** The deletion summary the tool returns as `structuredContent`. */
interface DeleteWorkItemResult {
  deleted: true;
  id: string;
  identifier: string;
  title: string;
  /** Rows removed — the root PLUS every descendant. */
  totalCount: number;
  /** `totalCount − 1`. */
  descendantCount: number;
  /** Per-kind breakdown of the DESCENDANTS only (zero-count kinds omitted). */
  byKind: Partial<Record<WorkItemKindDto, number>>;
}

/** "5 subtasks, 1 task" — the descendant breakdown as a compact phrase. */
function describeByKind(byKind: WorkItemDeletePreviewDto['byKind']): string {
  return Object.entries(byKind)
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`)
    .join(', ');
}

/** Resolve by key, capture the cascade impact, then permanently delete. */
export async function runDeleteWorkItem(
  args: DeleteArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    // Capture the magnitude BEFORE the rows are gone (the preview shares the
    // delete's manage gate, so a denial throws here and the delete never runs).
    const preview = await workItemsService.getDeletePreview(item.id, ctx);
    await workItemsService.deleteWorkItem(item.id, ctx);

    const result: DeleteWorkItemResult = {
      deleted: true,
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      totalCount: preview.totalCount,
      descendantCount: preview.descendantCount,
      byKind: preview.byKind,
    };
    const cascade =
      preview.descendantCount > 0
        ? ` and ${preview.descendantCount} descendant${preview.descendantCount === 1 ? '' : 's'} (${describeByKind(preview.byKind)})`
        : '';
    return toolOk(
      `Permanently deleted ${item.identifier} — ${item.title}${cascade}. This is irreversible ` +
        `(unlike archive_work_item, which is recoverable).`,
      result as unknown as Record<string, unknown>,
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerDeleteWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    DELETE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Delete work item',
      description:
        'PERMANENTLY delete a work item by identifier (e.g. "PROD-7") together with its entire ' +
        'subtree — every descendant, and all links / comments / history, are removed. This is ' +
        'IRREVERSIBLE: use archive_work_item instead when you want a recoverable soft-remove. ' +
        'Honors the same access checks as the UI (project-admin manage). Returns the deleted ' +
        'item plus the cascade count.',
      inputSchema,
    },
    async (args, extra) => runDeleteWorkItem(args, resolveContext(extra)),
  );
}
