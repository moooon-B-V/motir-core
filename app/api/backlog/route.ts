import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { backlogService } from '@/lib/services/backlogService';

// GET /api/backlog (Subtask 4.1.4) — one bounded, cursor-paginated page of the
// ACTIVE project's backlog (issues with `sprintId IS NULL`) in rank order, plus
// the total count for the "N issues" header (finding #57 — never load-all). Thin
// HTTP layer over backlogService.getBacklog; session-required; the project +
// workspace come from the active-project context (NEVER the client). No db / no
// transaction here (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[id]/backlog, which the 4.1.4 card
// sketches): the app is single-active-project — `/api/board`, `/api/sprints`,
// and the `/boards` / `/issues` pages all resolve getActiveProject() and there
// is NO project-by-key route tree to mirror. The card's path-param shape loses
// to the shipped active-project pattern (decision ladder: rung 2 shipped code >
// rung 3 card prose). The 4.2 backlog UI binds here against the active project.
//
// Query: ?cursor=<last id> (omit for page 1) · ?limit=<1..100> (default 50).
export async function GET(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const params = new URL(req.url).searchParams;
  const cursor = params.get('cursor')?.trim() || undefined;
  const limitRaw = params.get('limit')?.trim();
  // A non-numeric / out-of-range limit is clamped by the service (NaN → default),
  // not rejected — friendlier for a list fetch.
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const page = await backlogService.getBacklog(
    ctx.projectId,
    { cursor, limit },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
  return NextResponse.json(page);
}
