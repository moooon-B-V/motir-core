import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { sprintsService } from '@/lib/services/sprintsService';
import { SprintNotFoundError } from '@/lib/sprints/errors';

// GET /api/sprints/[id]/report (Subtask 4.4.4) — the sprint report: the
// completed vs. incomplete issue lists (each a bounded, cursor-paginated page +
// total), the points summary (committed baseline / completed / not-completed),
// and the "added during sprint" scope-change count (finding #57 — bounded
// aggregates, never load-all). Works for a complete sprint (the report) and an
// active one (the complete-modal live preview). Thin HTTP layer over
// sprintsService.getSprintReport; session-required; the sprint id is the path
// param (the sprint names its own project, so the workspace from the session
// context is the only gate — the service tenant-gates the sprint by workspace, a
// foreign / unknown sprint → 404). A READ open to any member (NOT owner-gated),
// like GET /api/sprints/[id]/issues. No db / no transaction here (CLAUDE.md). The
// 4.4.6 complete-flow UI binds here.
//
// Query: ?completedCursor / ?incompleteCursor=<last id> (omit for page 1) ·
//        ?limit=<1..100> (default 50; the two lists page independently).
//
// Typed errors → status codes:
//   SprintNotFoundError → 404
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  const search = new URL(req.url).searchParams;
  const completedCursor = search.get('completedCursor')?.trim() || undefined;
  const incompleteCursor = search.get('incompleteCursor')?.trim() || undefined;
  const limitRaw = search.get('limit')?.trim();
  // A non-numeric / out-of-range limit is clamped by the service (NaN → default),
  // not rejected — friendlier for a read.
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const report = await sprintsService.getSprintReport(
      id,
      { completedCursor, incompleteCursor, limit },
      ctx,
    );
    return NextResponse.json(report);
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
