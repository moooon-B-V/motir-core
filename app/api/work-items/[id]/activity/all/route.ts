import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { activityService } from '@/lib/services/activityService';
import { InvalidActivityCursorError } from '@/lib/activity/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

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
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

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
