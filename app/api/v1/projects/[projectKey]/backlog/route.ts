import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseCollectionPageRequest, readRowIdPosition } from '@/lib/api/v1/pagination';
import { parseRankedFilterParam, presentRankedPage } from '@/lib/api/v1/rankedCollections';
import { backlogService } from '@/lib/services/backlogService';
import { projectsService } from '@/lib/services/projectsService';

// GET /api/v1/projects/{projectKey}/backlog (Story 11.3 · Subtask 11.3.8 —
// MOTIR-2065) — the to-be-planned pile, in `backlogRank` order.
//
// A TRUE thin adapter, unlike 11.2's work-item list: `findBacklogPage` already
// windows in SQL with a seek-after cursor and a bounded `COUNT` alongside, so
// nothing new is needed at the service or repository layer. What this route owes
// is the translation between v1's signed, collection-scoped cursor and the
// service's own — the last row's id.
//
// ⚠️ The backlog EXCLUDES done-category issues, and its sibling (a sprint's
// members) does NOT. See `lib/api/v1/rankedCollections.ts` for why that
// asymmetry is correct in both directions.
export const GET = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading: a bad cursor, limit or filter is the caller's to fix,
  // and answering 422 without touching the database is both faster and honest.
  const page = parseCollectionPageRequest(ctx.req, 'backlog', readRowIdPosition);
  const filter = parseRankedFilterParam(ctx.req);

  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  const result = await backlogService.getBacklog(
    project.id,
    { limit: page.limit, ...(page.cursor !== undefined ? { cursor: page.cursor } : {}), ...filter },
    ctx.service,
  );

  return NextResponse.json(presentRankedPage(result, 'backlog'));
});
