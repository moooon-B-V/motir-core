import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemPlacement } from '../payloads/workItems';

// Work-item PLACEMENT for the MCP work-item tools (Story MOTIR-5310 ·
// MOTIR-5413). A work item sits under a work-item parent, in a folder, or at the
// project root — never both of the first two. `create_work_item` and
// `move_to_parent` report where the item landed, and `get_work_item` prints the
// same `Folder:` line, so all three read and render placement through here.

/**
 * The item's placement as it now stands: `parentKey` as the caller resolved it,
 * and the folder side read back off the ROW — never inferred from the call's
 * arguments, so a `move_to_parent { parentKey: null }` on a filed item reports the
 * folder the service kept.
 */
export async function readPlacement(
  workItemId: string,
  parentKey: string | null,
  ctx: ServiceContext,
): Promise<WorkItemPlacement> {
  const { folderId, folderPath } = await workItemsService.getWorkItemPlacement(workItemId, ctx);
  return { parentKey, folderId, folderPath };
}

/** A folder path as agents and `motir show` read it: `Parked ▸ 2025`. */
export function renderFolderPath(path: readonly string[]): string {
  return path.join(' ▸ ');
}

/** Where the item now sits, in words, for a write tool's text summary. */
export function describePlacement(placement: WorkItemPlacement): string {
  if (placement.parentKey !== null) return `under ${placement.parentKey}`;
  if (placement.folderId !== null) {
    const path = placement.folderPath ?? [];
    return path.length > 0 ? `in folder ${renderFolderPath(path)}` : 'in a folder';
  }
  return 'at the top level';
}
