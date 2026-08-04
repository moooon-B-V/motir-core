import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { encodeWorkItemETag, presentWorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET /api/v1/work-items/{key} (Story 11.2 · Subtask 11.2.2 — MOTIR-2040) — the
// single-item read, and the endpoint that PINS the work-item resource on the
// wire. Every sibling endpoint returns a shape declared in
// `lib/api/v1/workItems/schema.ts`.
//
// ⚠️ THE DYNAMIC SEGMENT IS `[key]`, and every sibling v1 route under
// `work-items` must use that SAME slug name. Next.js refuses to build when two
// sibling dynamic segments differ (`[key]` vs `[id]`), and it surfaces as a boot
// error rather than a type error — so it is invisible to `tsc` and fails late.
// 11.3's item-scoped routes inherit the name.
//
// 4-layer: resolve the key, call the service, present, return. No `db.*`, no
// `$transaction` — asserted over the whole tree by `tests/api/v1/story-gate.test.ts`.
//
// ── Why the ETag ────────────────────────────────────────────────────────────
// `PATCH` (11.2.6) accepts `If-Match` and passes it to `updateWorkItem`'s shipped
// `expectedUpdatedAt` precondition. THIS read is where a client gets the value it
// later sends back, so the validator is minted by the same module that parses it
// — a validator produced by one card and parsed by another is a contract, and it
// belongs with the resource.
export const GET = withV1Route<{ key: string }>({ scope: 'read' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx.service);

  // `commentCount` is deliberately NOT on `IssueDetailDto` (`lib/mcp/commentCounts.ts`
  // records why: widening that aggregate breaks every exact-`toEqual` route-shape
  // test that reads it back), so it is read here and handed to the presenter.
  const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx.service);

  ctx.responseHeaders.set('ETag', encodeWorkItemETag(detail.item.updatedAt));
  return NextResponse.json(presentWorkItemDetail(detail, counts[detail.item.id] ?? 0));
});
