import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  commentCountFor,
  encodeWorkItemETag,
  presentWorkItemDetail,
} from '@/lib/api/v1/workItems/schema';
import { readChildDependencyEdges } from '@/lib/api/v1/workItems/childEdges';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/restore (Story 11.2 · Subtask 11.2.10 —
// MOTIR-2052) — the ONLY removal operation /api/v1 exposes, and the reason it
// can be exposed at all: archiving is a REVERSIBLE soft-remove that does NOT
// cascade (`archiveWorkItem` sets `archivedAt` on ONE row and records a
// revision; children are untouched).
//
// The irreversible subtree delete stays unexposed — ADR §3 rejects it for the
// first cut, `work_items:delete` is off by default in `DEFAULT_TOKEN_SCOPES`,
// and exposing it later is additive under §8 while withdrawing it could not be.
//
// ⚠️ ITS OWN PERMISSION, distinct from `work_item:edit`: a token that may EDIT
// an item may not therefore REMOVE it. And a grant NARROWS, never widens — the
// service asserts the same key, so a `work_item:archive` token held by someone
// whose role withholds it is refused all the same.
//
// ⚠️ THE KEY IS `work_item:archive` (MOTIR-3629), and this route is why it
// exists. The header above says archiving does NOT cascade and IS reversible;
// the key it used to declare was `work_item:delete`, named for the operation
// that is neither. `/api/v1` deliberately exposes archive and not delete, and
// under one key that could only be expressed by the route AUDIT admitting these
// two paths by NAME (`tests/helpers/v1RouteAudit.ts`) — a path allow-list
// standing in for a permission. That exception is deleted with this change, and
// the audit keys on the permission again: any v1 route declaring
// `work_item:delete` is now a violation with no carve-out.
//
// IDEMPOTENT: the service raises no already-archived error, it simply re-stamps.
// Said here rather than inventing a conflict status the service does not produce.
export const POST = withV1Route<{ key: string }>(
  { permission: 'work_item:archive' },
  async (ctx) => {
    const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

    await workItemsService.unarchiveWorkItem(item.id, ctx.service);

    const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx.service);
    const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx.service);
    ctx.responseHeaders.set('ETag', encodeWorkItemETag(detail.item.updatedAt));
    const childEdges = await readChildDependencyEdges(detail, ctx.service);
    const deliveries = await workItemsService.listDeliverySet(detail.item.id, ctx.service);
    return NextResponse.json(
      presentWorkItemDetail(
        detail,
        commentCountFor(counts, detail.item.id),
        childEdges,
        deliveries,
      ),
    );
  },
);
