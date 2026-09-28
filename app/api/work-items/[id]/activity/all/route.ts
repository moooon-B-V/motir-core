import { NextResponse } from 'next/server';
import { memberThenVisitor } from '@/lib/visitor/readActor';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { activityService } from '@/lib/services/activityService';
import { InvalidActivityCursorError } from '@/lib/activity/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/[id]/activity/all (Story 5.5 · Subtask 5.5.2) — one
// page of the issue's merged Activity stream: 5.1 comment threads and 5.5.1
// history entries interleaved in true timestamp order. `?cursor=` is the
// OPAQUE composite continuation token (it carries both sources' positions —
// clients echo it back verbatim, never construct it); `?order=asc|desc`
// (default desc — newest first) applies to both sources together (the
// section's one cross-tab sort toggle). READ-ONLY surface like its `history`
// sibling: the route tree deliberately exposes no POST / PATCH / DELETE —
// and must never grow one. Thin HTTP layer over `activityService.listAll`;
// no db / no transaction here (CLAUDE.md).
//
// Typed errors → status codes:
//   WorkItemNotFoundError      → 404 (unknown / cross-workspace item, no existence leak)
//   InvalidActivityCursorError → 400 (malformed composite cursor)
//   malformed ?order           → 400
/** The read itself, for a member's context or a Visitor's (MOTIR-6647). */
async function serve(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: ServiceContext | VisitorReadContext,
): Promise<Response> {
  const { id } = await params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const orderParam = url.searchParams.get('order');
  if (orderParam !== null && orderParam !== 'asc' && orderParam !== 'desc') {
    return NextResponse.json({ code: 'INVALID_ORDER' }, { status: 400 });
  }

  try {
    const page = await activityService.listAll(id, { cursor, order: orderParam ?? undefined }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidActivityCursorError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    throw err;
  }
}

async function memberGET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  return serve(req, route, ctx);
}

/**
 * A work item's comments-and-history stream — members exactly as before; a
 * VISITOR (MOTIR-6647) of the item's public project reads it through the Visitor
 * path (MOTIR-6652: a row naming a withheld item renders as unavailable), only
 * when the member read found nothing for them.
 */
export async function GET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  return memberThenVisitor(
    req,
    () => memberGET(req, route),
    (ctx) => serve(req, route, ctx),
  );
}
