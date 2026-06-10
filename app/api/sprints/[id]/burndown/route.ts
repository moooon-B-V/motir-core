import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { reportsService } from '@/lib/services/reportsService';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';

// GET /api/sprints/[id]/burndown (Story 4.6 · Subtask 4.6.3) — the in-sprint
// BURNDOWN series: the guideline (committed → 0 over the sprint window) + the
// actual stepped remaining line reconstructed from the 4.4.2 committed baseline
// and the 1.4.6 revision trail, plus the mid-sprint scope-change markers
// (finding #57 — a bounded grouped per-day aggregate, never load-all). Works for
// an active sprint (actual to "today") and a completed one (actual to
// `completedAt`); the 4.6.5 scrum-header + sprint-report chart seams bind here.
//
// Thin HTTP layer per CLAUDE.md: workspace context, ONE service call, map the
// typed errors. The service tenant-gates the sprint by workspace (a sprint
// outside the active workspace is a 404 — the finding-#26 gate). A READ open to
// any member (NOT owner-gated), like GET /api/sprints/[id]/points. No db / no
// transaction here.
//
// Typed errors → status codes:
//   SprintNotFoundError   → 404
//   SprintNotStartedError → 409 (a planned sprint has no window to draw)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    const series = await reportsService.getBurndownSeries(id, ctx);
    return NextResponse.json(series);
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof SprintNotStartedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
