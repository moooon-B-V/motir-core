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
// They follow `…/ready/route.ts` line for line, and its header is the contract:
// a route does not filter, re-rank or re-derive readiness. Each calls ONE lane
// read of the service, plus — for the two row lanes — the page's batched edge
// projection (ADR Amendment 3 Q4). The lane cursor is the service's own opaque
// token, wrapped in v1's signed envelope under a collection name PER LANE, so a
// cursor from one lane is refused by another at parse time.

type Ctx = V1RouteContext<{ projectKey: string }>;

/** The service's two refusals, mapped exactly as the flat ready route maps them. */
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
