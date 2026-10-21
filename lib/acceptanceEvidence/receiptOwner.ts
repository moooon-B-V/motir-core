import type { WorkItem } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

/**
 * Which card a run's acceptance receipt hangs on (MOTIR-9209).
 *
 * A receipt belongs to a RUNNABLE CONTAINER: a story, or a bug / task that has
 * children and is therefore run as a parent. A leaf resolves UP to the container
 * that owns it; an epic and a childless card with no such parent own nothing.
 *
 * ⚠️ ONE RULE, SHARED BY EVERY DOOR. The HTTP routes, the MCP publish tools and
 * the service's own target check all ask this module, so the publisher and the
 * status read cannot disagree about whose receipt is under discussion (MOTIR-4144).
 */
const CONTAINER_KINDS = new Set(['story', 'bug', 'task']);

type OwnerShape = Pick<WorkItem, 'id' | 'kind' | 'parentId'>;

/** True when the item can hold a receipt itself: a story, or a bug / task with children. */
export async function isReceiptOwner(
  item: OwnerShape,
  ctx: { userId: string; workspaceId: string },
): Promise<boolean> {
  if (item.kind === 'story') return true;
  if (item.kind !== 'bug' && item.kind !== 'task') return false;
  const children = await withWorkspaceContext(ctx, (tx) =>
    workItemRepository.findChildren(item.id, tx),
  );
  return children.length > 0;
}

/**
 * The container above `item` that owns its receipt, or null when the item owns it
 * directly (or nothing above it can — the caller then rejects it NOT_A_STORY).
 */
export async function findOwningReceiptParent(
  item: OwnerShape,
  ctx: { userId: string; workspaceId: string },
): Promise<WorkItem | null> {
  if (!item.parentId || (await isReceiptOwner(item, ctx))) return null;
  const parentId = item.parentId;
  const parent = await withWorkspaceContext(ctx, (tx) => workItemRepository.findById(parentId, tx));
  return parent && CONTAINER_KINDS.has(parent.kind) ? parent : null;
}
