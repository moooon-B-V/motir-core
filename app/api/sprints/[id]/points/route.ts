import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { estimationService } from '@/lib/services/estimationService';
import { SprintNotFoundError } from '@/lib/sprints/errors';

// GET /api/sprints/[id]/points (Story 4.4 · Subtask 4.4.9 — finding #69) — the
// live pre-start points roll-up for a sprint: `{ committed, completed, remaining }`
// from the shipped `estimationService.rollupForSprint` (the bounded grouped
// aggregate, finding-#57-safe; the SUM lives in ONE place). It powers two
// pre-start display consumers that previously had no points source: the backlog
// `SprintContainer` committed-points slot and the `StartSprintDialog` committed
// summary ("{n} issues · {p} points committed at start"). A wholly unestimated
// sprint returns `{ 0, 0, 0 }` (the DTO stays total; the UI owns the "—").
//
// Thin HTTP layer per CLAUDE.md: workspace context, ONE service call, map the
// typed error. The service tenant-gates the sprint by workspace (a sprint
// outside the active workspace is a 404 — the finding-#26 gate). No db / no
// transaction here.
//
// Typed errors → status codes:
//   SprintNotFoundError → 404
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    const points = await estimationService.rollupForSprint(id, ctx);
    return NextResponse.json(points);
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
