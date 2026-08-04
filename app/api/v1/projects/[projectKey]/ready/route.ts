import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import {
  encodeCollectionCursor,
  MAX_PAGE_LIMIT,
  parseCollectionPageRequest,
  readRowIdPosition,
} from '@/lib/api/v1/pagination';
import { parseReadyFilters, presentReadyItem } from '@/lib/api/v1/ready/schema';
import { InvalidReadyCursorError } from '@/lib/workItems/readyFilter';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// GET /api/v1/projects/{projectKey}/ready (Story 11.3 · Subtask 11.3.9 —
// MOTIR-2066) — the endpoint that makes external agent orchestration possible
// without MCP.
//
// ── ⚠️ READINESS IS COMPUTED, AND THIS ROUTE DOES NOT COMPUTE IT ────────────
// An item is ready when it is a CHILDLESS LEAF, in a non-terminal status, with
// every `is_blocked_by` blocker terminal AND EVERY ANCESTOR READY — the
// parent-ready cascade. `workItemsService.listReady` implements exactly that,
// top-down by layer.
//
// A flat "all its own blockers are done" check is a DIFFERENT AND WRONG answer,
// and it is the answer a route that re-derived readiness would give. So this
// route calls the service and does not filter, re-sort, re-rank or post-process
// the result. An agent loop that disagrees with the board about what is ready is
// worse than no endpoint at all.
//
// It also does not import from `lib/mcp/`. The MCP `list_ready` tool does the
// same two reads and was READ while writing this, but it is a reference SHAPE,
// not a dependency: the two transports align through the service, and a shipped
// guard asserts no v1 route reaches into the tool layer.
//
// ── The ORDER is the product ────────────────────────────────────────────────
// Rows come back in the dispatch rank `(type asc, priority desc, key asc)`, so
// `items[0]` is what an agent should take next. Paging by any other key would
// silently destroy that — which is exactly why 11.3.2's service-positioned
// cursor exists. The v1 cursor here WRAPS the shipped `(kind, priority, key)`
// seek-after token rather than replacing it.
//
// ── Two service calls, and that is the RULE, not an exception ───────────────
// `listReady` for the page, then `getDependencyEdgesForItems` for that page's
// edges — a BOUNDED, CONSTANT projection over the ids the first call returned
// (two queries for the whole page, whatever its size). ADR Amendment 3 (Q4)
// permits precisely this and forbids the per-row form: an N+1 here is invisible
// until a 100-row page.
export const GET = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading. The ready cursor is the service's own opaque token,
  // wrapped in v1's signed collection envelope — so a cursor from another
  // collection is refused here rather than decoded into a meaningless position.
  const page = parseCollectionPageRequest(ctx.req, 'ready', readRowIdPosition);
  const filters = parseReadyFilters(ctx.req);

  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);

  let result;
  try {
    result = await workItemsService.listReady(
      project.id,
      {
        ...filters,
        // ⚠️ v1's OWN ceiling. `clampReadyLimit` allows 200; §5 documents 100 and
        // `parseCollectionPageRequest` has already clamped to it, so the service
        // never sees a larger number. An underlying read does not raise v1's cap.
        limit: Math.min(page.limit, MAX_PAGE_LIMIT),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      },
      ctx.service,
    );
  } catch (err) {
    // The shipped ready codec throws its own error type for a token it did not
    // issue. That can only be reached by a cursor v1 signed but the service
    // rejects — a version skew rather than a client mistake — and it maps to the
    // same 422 as any other bad cursor rather than escaping as a bare 500.
    if (err instanceof InvalidReadyCursorError) {
      throw new InvalidRequestError(
        'INVALID_CURSOR',
        'The `cursor` parameter is not a valid page cursor.',
      );
    }
    throw err;
  }

  const edges = await workItemsService.getDependencyEdgesForItems(
    result.items.map((item) => item.id),
    ctx.service,
  );

  return NextResponse.json({
    items: result.items.map((item) => presentReadyItem(item, edges[item.id])),
    nextCursor:
      result.nextCursor === null ? null : encodeCollectionCursor('ready', result.nextCursor),
  });
});
