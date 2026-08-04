import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  decodeWorkItemETag,
  encodeWorkItemETag,
  parseV1Body,
  presentWorkItemDetail,
  updateWorkItemBodySchema,
} from '@/lib/api/v1/workItems/schema';
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

// PATCH /api/v1/work-items/{key} (Subtask 11.2.6 — MOTIR-2046) — the partial
// update, with OPTIONAL optimistic concurrency.
//
// ── `If-Match`, the HTTP-native form of a guard the service already has ──────
// `updateWorkItem` accepts `{ expectedUpdatedAt }` and raises `StaleWorkItemError`
// when the row moved underneath the caller. That is exposed as `If-Match` rather
// than as an invented body field, and the validator is DECODED with the same
// module's function that MINTED it on the read above — not re-derived here.
//
// ⚠️ OMITTING `If-Match` is LEGAL and means last-write-wins — unchanged from
// today's behaviour. This adds a guarantee a client can opt into; it does not
// make one mandatory. Two agents patching the same item is the epic's own stated
// normal, which is why the guard is exposed rather than left internal.
export const PATCH = withV1Route<{ key: string }>({ scope: 'work_items:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, updateWorkItemBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const target = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  const ifMatch = ctx.req.headers.get('if-match');
  const expected = ifMatch ? decodeWorkItemETag(ifMatch).toISOString() : undefined;

  // `parentKey` → the internal parent id. `null` clears the parent; an absent
  // key leaves it alone — the distinction the request schema draws, carried
  // through rather than flattened.
  const parentPatch =
    body.parentKey === undefined
      ? {}
      : {
          parentId:
            body.parentKey === null
              ? null
              : (
                  await workItemsService.getWorkItemByIdentifier(
                    projectId,
                    body.parentKey.toUpperCase(),
                    ctx.service,
                  )
                ).id,
        };

  await workItemsService.updateWorkItem(
    target.id,
    {
      ...pickSupplied(body, [
        'kind',
        'title',
        'descriptionMd',
        'explanationMd',
        'priority',
        'type',
        'executor',
        'storyPoints',
        'estimateMinutes',
        'targetRepo',
        'assigneeId',
        'dueDate',
      ]),
      ...parentPatch,
    },
    ctx.service,
    ...(expected ? [{ expectedUpdatedAt: expected }] : []),
  );

  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx.service);
  const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx.service);
  ctx.responseHeaders.set('ETag', encodeWorkItemETag(detail.item.updatedAt));
  return NextResponse.json(presentWorkItemDetail(detail, counts[detail.item.id] ?? 0));
});

/**
 * Copy only the keys the caller actually SUPPLIED.
 *
 * `exactOptionalPropertyTypes` makes `{ x: undefined }` and `{}` different
 * types, and the service distinguishes ABSENT (leave alone) from `null` (clear)
 * — so spreading the parsed body wholesale would turn every omitted field into
 * an explicit `undefined` and blur exactly the distinction the schema drew.
 */
function pickSupplied<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
