import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { encodePageCursor, parsePageRequest } from '@/lib/api/v1/pagination';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { parseV1Body, presentComment, presentCommentThread } from '@/lib/api/v1/workItems/schema';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET + POST /api/v1/work-items/{key}/comments (Story 11.2 · Subtask 11.2.8 —
// MOTIR-2049) — the half of a work item that is conversation rather than fields.
//
// ── ⚠️ The service's cursor is NOT passed through ───────────────────────────
// `CommentsPageDTO.nextCursor` is a BARE root-comment id — not opaque, not
// signed, and therefore forgeable. `lib/api/v1/pagination.ts` refuses exactly
// that: "a client that can hand-craft a cursor has made the underlying sort key
// public API", which turns a future index change into a breaking change. So the
// v1 cursor is minted here — signed and opaque like every other collection's —
// and only its decoded `id` is handed back to the service.
//
// ── The short-page case is NORMAL ───────────────────────────────────────────
// A page may be SHORTER than `limit` while more remains: the service pages ROOT
// comments and each root drags its whole reply thread along. A client must
// therefore walk until `nextCursor` is null rather than until a short page —
// the same note `lib/mcp/tools/getWorkItemActivity.ts` records.

const commentBodySchema = z
  .object({ bodyMd: z.string().min(1), parentCommentId: z.string().nullish() })
  .strict();

const orderSchema = z.enum(['asc', 'desc']);

export const GET = withV1Route<{ key: string }>({ scope: 'read' }, async (ctx) => {
  const page = parsePageRequest(ctx.req);
  const rawOrder = new URL(ctx.req.url).searchParams.get('order');
  const parsedOrder = rawOrder === null ? undefined : orderSchema.safeParse(rawOrder);
  if (parsedOrder && !parsedOrder.success) {
    throw new InvalidRequestError(
      'INVALID_ORDER',
      'The `order` parameter must be `asc` or `desc`.',
    );
  }

  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  const result = await commentsService.listComments(
    item.id,
    {
      limit: page.limit,
      // The v1 cursor carries `{ createdAt, id }`; the service addresses a page
      // by root-comment id alone, so only the `id` half crosses that boundary.
      ...(page.cursor ? { cursor: page.cursor.id } : {}),
      ...(parsedOrder?.success ? { order: parsedOrder.data } : {}),
    },
    ctx.service,
  );

  const last = result.threads[result.threads.length - 1];
  return NextResponse.json({
    items: result.threads.map(presentCommentThread),
    totalCount: result.totalCount,
    // Re-wrapped, never forwarded: `result.nextCursor` being non-null is the
    // "more remains" signal, and the position is named by the last root comment
    // this page actually returned.
    nextCursor:
      result.nextCursor !== null && last
        ? encodePageCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  });
});

export const POST = withV1Route<{ key: string }>({ scope: 'work_items:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, commentBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  // `parentCommentId` makes it a reply; the service owns depth and parent
  // validation, so a second-level reply is its typed error, not a check here.
  const created = await commentsService.addComment(
    item.id,
    {
      bodyMd: body.bodyMd,
      ...(body.parentCommentId ? { parentCommentId: body.parentCommentId } : {}),
    },
    ctx.service,
  );

  return NextResponse.json(presentComment(created), { status: 201 });
});
