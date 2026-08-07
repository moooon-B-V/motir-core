import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import {
  decodeCollectionCursor,
  encodeCollectionCursor,
  readRowIdPosition,
} from '@/lib/api/v1/pagination';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentCommentThread } from '@/lib/api/v1/workItems/schema';
import {
  ACTIVITY_COLLECTION,
  ACTIVITY_VIEWS,
  presentActivityChange,
  type V1ActivityEntry,
  type V1ActivityView,
} from '@/lib/api/v1/workLoop/schema';
import { activityService } from '@/lib/services/activityService';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET /api/v1/work-items/{key}/activity (Story 11.7 · Subtask 11.7.7 —
// MOTIR-2241) — a work item's change trail, its discussion, and the merged
// stream that interleaves them.
//
// ── The shipped `…/comments` endpoint is NOT withdrawn ──────────────────────
// It is public API under ADR §8 and could not be, and it remains the canonical
// address for the discussion. `?view=comments` exists so a client that walks all
// three views does it with ONE code path, and both read the same
// `commentsService.listComments`, so they cannot disagree about what a comment
// is. The comment side even reuses 11.2's `presentCommentThread` verbatim.
//
// ── The `all` cursor is an OPAQUE COMPOSITE and this route never touches it ──
// The merged view pages over TWO sources, so the service's cursor carries both
// positions (`decodeAllCursor`). This route passes it through untouched in both
// directions: it never constructs, parses, splits or merges one, and it never
// loops to drain the stream. What it DOES do is wrap it in v1's signed,
// collection-scoped envelope — and with ONE COLLECTION NAME PER VIEW, so a
// cursor issued for `all` and handed to `history` is a 422 rather than a
// meaningless seek. Sharing one name would decode cleanly and land nowhere,
// which is the silent reset §5 forbids.
//
// ── STABLE INTERLEAVING is the service's, and that is the point ─────────────
// Two sources merged by timestamp, with ties and no tiebreak, duplicate or drop
// rows at a page boundary — the bug that only appears on real data. This route
// does not merge, re-sort or post-process: `activityService.listAll` owns the
// order and the cursor that resumes it, so the property holds here because
// nothing here can break it.
//
// ── NO `limit` ─────────────────────────────────────────────────────────────
// The page size is the underlying reads' own bounded window (the History scan is
// bounded by noise-filtering, and a comment page drags whole reply threads
// along), so a `limit` would be a parameter that silently does nothing on two of
// the three views. A client walks until `nextCursor` is null — never until a
// page looks short, which is DOCUMENTED normal here.

const ORDERS = ['asc', 'desc'] as const;

function parseView(params: URLSearchParams): V1ActivityView {
  const raw = params.get('view');
  if (raw === null || raw === '') return 'all';
  if ((ACTIVITY_VIEWS as readonly string[]).includes(raw)) return raw as V1ActivityView;
  throw new InvalidRequestError(
    'INVALID_ACTIVITY_VIEW',
    'The `view` parameter must be `all`, `comments` or `history`.',
  );
}

function parseOrder(params: URLSearchParams): 'asc' | 'desc' | undefined {
  const raw = params.get('order');
  if (raw === null || raw === '') return undefined;
  if ((ORDERS as readonly string[]).includes(raw)) return raw as 'asc' | 'desc';
  throw new InvalidRequestError('INVALID_ORDER', 'The `order` parameter must be `asc` or `desc`.');
}

export const GET = withV1Route<{ key: string }>({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading: a bad view, order or cursor is the caller's to fix.
  const params = new URL(ctx.req.url).searchParams;
  const view = parseView(params);
  const order = parseOrder(params);
  const rawCursor = params.get('cursor');
  const cursor =
    rawCursor !== null && rawCursor !== ''
      ? decodeCollectionCursor(rawCursor, ACTIVITY_COLLECTION[view], readRowIdPosition)
      : undefined;

  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  const options = { ...(cursor === undefined ? {} : { cursor }), ...(order ? { order } : {}) };
  const wrap = (next: string | null): string | null =>
    next === null ? null : encodeCollectionCursor(ACTIVITY_COLLECTION[view], next);

  if (view === 'comments') {
    const page = await commentsService.listComments(item.id, options, ctx.service);
    return NextResponse.json({
      items: page.threads.map(
        (thread): V1ActivityEntry => ({ type: 'comment', comment: presentCommentThread(thread) }),
      ),
      nextCursor: wrap(page.nextCursor),
      totalCount: page.totalCount,
      // This view counted comments and nothing else. `totalChanges: 0` would
      // say the item has no history, which is a different — and usually false —
      // claim than "this read did not look" (ADR Amendment 13).
      totalComments: page.totalCount,
      totalChanges: null,
    });
  }

  if (view === 'history') {
    const page = await activityService.listHistory(item.id, options, ctx.service);
    return NextResponse.json({
      items: page.entries.map(
        (entry): V1ActivityEntry => ({ type: 'change', change: presentActivityChange(entry) }),
      ),
      nextCursor: wrap(page.nextCursor),
      totalCount: page.totalCount,
      totalComments: null,
      totalChanges: page.totalCount,
    });
  }

  const page = await activityService.listAll(item.id, options, ctx.service);
  return NextResponse.json({
    items: page.entries.map(
      (entry): V1ActivityEntry =>
        entry.type === 'comment'
          ? { type: 'comment', comment: presentCommentThread(entry.thread) }
          : { type: 'change', change: presentActivityChange(entry.entry) },
    ),
    nextCursor: wrap(page.nextCursor),
    // The merged view's total is the merged count — both halves are bounded
    // aggregates the read already paid for, so this is the ranked envelope's
    // documented condition rather than an extra query.
    totalCount: page.totalComments + page.totalChanges,
    // The split behind that sum. Both are bounded aggregates the read already
    // paid for, so publishing them costs nothing — and the merged view is the
    // one place a single total cannot answer "how many are there".
    totalComments: page.totalComments,
    totalChanges: page.totalChanges,
  });
});
