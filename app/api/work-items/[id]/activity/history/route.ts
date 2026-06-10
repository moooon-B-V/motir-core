import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { activityService } from '@/lib/services/activityService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[id]/activity/history (Story 5.5 · Subtask 5.5.1) —
// one page of the issue's History feed: displayable `work_item_revision`
// entries rendered to typed parts, `?cursor=` continuation + `?order=asc|desc`
// (default desc — newest first). READ-ONLY surface: the revision trail is
// append-only (the verified Jira rule), so this route tree deliberately
// exposes no POST / PATCH / DELETE — and must never grow one. Thin HTTP layer
// over `activityService.listHistory`; no db / no transaction here (CLAUDE.md).
// The sibling `all` route (Subtask 5.5.2) adds the merged comments+history
// stream beside this one.
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (unknown / cross-workspace item, no existence leak)
//   malformed ?order      → 400
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
    const page = await activityService.listHistory(
      id,
      { cursor, order: orderParam ?? undefined },
      ctx,
    );
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
