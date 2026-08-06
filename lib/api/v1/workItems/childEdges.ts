import { workItemsService } from '@/lib/services/workItemsService';
import type { IssueDetailDto, WorkItemDependencyEdgesDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The detail resource's CHILD-EDGE projection (Story 11.7 · Subtask 11.7.2 —
// MOTIR-2236), in one place because SIX routes return `presentWorkItemDetail`.
//
// ── Why every one of them, and not just the read ────────────────────────────
// `workItemDetailSchema.children[].dependencies` is TOTAL: two arrays, always
// present. A write route that skipped the projection would therefore not omit
// the block — it would publish `{ blockedBy: [], blocks: [] }` on every child,
// which says "this child has no dependencies" about children that do. An absent
// field is a gap a client can see; a wrong one is not. So the projection runs
// wherever the detail is returned.
//
// ── BOUNDED, and free when there is nothing to bound ────────────────────────
// One batched call for the whole child set, whatever its size — the form ADR
// Amendment 3 Q4 permits and Amendment 6 Q4 applies here; a per-child read is
// the N+1 that is invisible on a 3-child fixture and quadratic on a 43-child
// story. And `getDependencyEdgesForItems` returns immediately on an empty id
// list without touching the database, so a childless item (every create, every
// leaf) pays nothing for the uniformity.
//
// It is a route-layer helper that calls ONE service method, the same shape
// `resolveKey.ts` uses: no `db.*`, no transaction, no business logic — the
// result is attached to rows the route already has, which is precisely what
// separates a projection from an answer the route derives.

/**
 * Read the dependency edges of a detail aggregate's CHILDREN, keyed by the
 * child's internal id — the shape {@link presentWorkItemDetail} takes.
 */
export async function readChildDependencyEdges(
  detail: IssueDetailDto,
  ctx: ServiceContext,
): Promise<Record<string, WorkItemDependencyEdgesDto>> {
  return workItemsService.getDependencyEdgesForItems(
    detail.children.map((child) => child.id),
    ctx,
  );
}
