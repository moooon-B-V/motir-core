import { NextResponse } from 'next/server';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import type { V1RouteContext } from '@/lib/api/v1/route';
import {
  encodeCollectionCursor,
  MAX_PAGE_LIMIT,
  parseCollectionPageRequest,
  readRowIdPosition,
  type V1Collection,
} from '@/lib/api/v1/pagination';
import {
  parseReadyContainerFilters,
  parseReadyFilters,
  presentReadyContainer,
  presentReadyLaneItem,
} from '@/lib/api/v1/ready/schema';
import { InvalidReadyCursorError, InvalidReadyFilterError } from '@/lib/workItems/readyFilter';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// The three READY-LANE handlers (Story MOTIR-6829 · MOTIR-6832) — the bodies of
// `GET /api/v1/projects/{projectKey}/ready/{leaves,containers,bugs}`.
//
// They were written line for line after the flat `GET …/ready` route (MOTIR-2066),
// which MOTIR-6841 deleted once the released CLI read only these lanes. Its
// contract lives here now:
//
// ── ⚠️ READINESS IS COMPUTED, AND THESE ROUTES DO NOT COMPUTE IT ─────────────
// An item is ready when it is a CHILDLESS LEAF, in a non-terminal status, with
// every `is_blocked_by` blocker terminal AND EVERY ANCESTOR READY — the
// parent-ready cascade, which the service's lane reads implement top-down by
// layer. A flat "all its own blockers are done" check is a DIFFERENT AND WRONG
// answer, and it is the answer a route that re-derived readiness would give. So
// a route calls the service and does not filter, re-sort, re-rank or
// post-process the result: an agent loop that disagrees with the board about
// what is ready is worse than no endpoint at all. Nor does it import from
// `lib/mcp/` — the two transports align through the service.
//
// ── The ORDER is the product ────────────────────────────────────────────────
// `items[0]` is what an agent should take next, so the page cursor is the
// service's own opaque position, wrapped in v1's signed envelope under a
// collection name PER LANE — a cursor from one lane is refused by another at
// parse time, never decoded into a meaningless position.
//
// ── The SCOPE facets are RESOLVED by the service, not here ──────────────────
// `?ancestor=` and `?sprintId=` (MOTIR-3196) name things rather than declaring
// values, so no parser can settle them; the service resolves both inside the
// read it was already making and throws `InvalidReadyFilterError`, mapped below
// to the same 422 the vocabulary facets raise.
//
// ── ONE lane read, then ONE batched edge read ───────────────────────────────
// For the two row lanes, the page's `blocked_by` edges come from
// `getDependencyEdgesForItems` over the ids the lane read returned — a bounded
// projection (ADR Amendment 3 Q4). The per-row form is an N+1 that stays
// invisible until a 100-row page.

type Ctx = V1RouteContext<{ projectKey: string }>;

/** The service's two refusals, each mapped to a 422. */
function mapReadyError(err: unknown): never {
  if (err instanceof InvalidReadyCursorError) {
    throw new InvalidRequestError(
      'INVALID_CURSOR',
      'The `cursor` parameter is not a valid page cursor.',
    );
  }
  if (err instanceof InvalidReadyFilterError) {
    throw new InvalidRequestError('INVALID_READY_FILTER', err.message);
  }
  throw err;
}

/** `GET …/ready/leaves` and `GET …/ready/bugs` — the two ROW lanes. */
export async function serveReadyRowLane(ctx: Ctx, lane: 'leaf' | 'bug'): Promise<Response> {
  const collection: V1Collection = lane === 'leaf' ? 'ready.leaves' : 'ready.bugs';
  const page = parseCollectionPageRequest(ctx.req, collection, readRowIdPosition);
  const filters = parseReadyFilters(ctx.req);
  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  const read = lane === 'leaf' ? workItemsService.listReadyLeaves : workItemsService.listReadyBugs;
  let result;
  try {
    result = await read(
      project.id,
      {
        ...filters,
        limit: Math.min(page.limit, MAX_PAGE_LIMIT),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      },
      ctx.service,
    );
  } catch (err) {
    mapReadyError(err);
  }
  const edges = await workItemsService.getDependencyEdgesForItems(
    result.items.map((item) => item.id),
    ctx.service,
  );
  return NextResponse.json({
    items: result.items.map((item) => presentReadyLaneItem(item, edges[item.id])),
    nextCursor:
      result.nextCursor === null ? null : encodeCollectionCursor(collection, result.nextCursor),
  });
}

/** `GET …/ready/containers` — the runnable containers, facets on the container. */
export async function serveReadyContainerLane(ctx: Ctx): Promise<Response> {
  const page = parseCollectionPageRequest(ctx.req, 'ready.containers', readRowIdPosition);
  const filters = parseReadyContainerFilters(ctx.req);
  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  let result;
  try {
    result = await workItemsService.listReadyContainers(
      project.id,
      {
        ...filters,
        limit: Math.min(page.limit, MAX_PAGE_LIMIT),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      },
      ctx.service,
    );
  } catch (err) {
    mapReadyError(err);
  }
  return NextResponse.json({
    items: result.items.map(presentReadyContainer),
    nextCursor:
      result.nextCursor === null
        ? null
        : encodeCollectionCursor('ready.containers', result.nextCursor),
  });
}
