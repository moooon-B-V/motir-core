import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { backlogService } from '@/lib/services/backlogService';
import { SprintNotFoundError } from '@/lib/sprints/errors';

// GET /api/sprints/[id]/issues (Subtask 4.1.4) — a sprint's ranked issues as a
// bounded, cursor-paginated page + the committed-issue count (finding #57). Thin
// HTTP layer over backlogService.getSprintIssues; session-required; the sprint
// id is the path param (the sprint names its own project, so the workspace from
// the session context is the only gate needed — the service tenant-gates the
// sprint by workspace, a foreign / unknown sprint → 404). No db / no transaction
// here (CLAUDE.md). The 4.2 sprint-planning view binds here.
//
// Query: ?cursor=<last id> (omit for page 1) · ?limit=<1..100> (default 50).
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
  const cursor = search.get('cursor')?.trim() || undefined;
  const limitRaw = search.get('limit')?.trim();
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const page = await backlogService.getSprintIssues(id, { cursor, limit }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
