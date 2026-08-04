import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  commentCountFor,
  encodeWorkItemETag,
  presentWorkItemDetail,
} from '@/lib/api/v1/workItems/schema';
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
// ⚠️ ITS OWN SCOPE, distinct from `work_items:write`: a token that may EDIT an
// item may not therefore REMOVE it. And scopes NARROW, never widen — the service
// still gates on `assertCanEdit`, so a `work_items:archive` token held by
// someone without project edit rights is refused all the same.
//
// IDEMPOTENT: the service raises no already-archived error, it simply re-stamps.
// Said here rather than inventing a conflict status the service does not produce.
export const POST = withV1Route<{ key: string }>({ scope: 'work_items:archive' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  await workItemsService.unarchiveWorkItem(item.id, ctx.service);

  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx.service);
  const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx.service);
  ctx.responseHeaders.set('ETag', encodeWorkItemETag(detail.item.updatedAt));
  return NextResponse.json(presentWorkItemDetail(detail, commentCountFor(counts, detail.item.id)));
});
