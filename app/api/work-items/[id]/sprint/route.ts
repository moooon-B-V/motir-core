import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { backlogService } from '@/lib/services/backlogService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';

// POST /api/work-items/[id]/sprint (Subtask 4.1.4) — assign an issue to a sprint
// or move it back to the backlog. Thin HTTP layer over backlogService; the issue
// id is the path param, the workspace + actor come from the session context
// (getWorkspaceContext — the issue names its OWN project, so no active-project
// coupling is needed, unlike the planning-VIEW reads). No db / no transaction
// here (CLAUDE.md).
//
// Body:
//   { sprintId: string,  beforeId?, afterId? }  → assignToSprint (optional drop
//                                                  placement within the sprint)
//   { sprintId: null }                          → moveToBacklog
//
// Typed errors → status codes:
//   WorkItemNotFoundError              → 404
//   SprintNotFoundError                → 404
//   CrossProjectSprintAssignmentError  → 422
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { sprintId, beforeId, afterId } = (body ?? {}) as Record<string, unknown>;
  if (sprintId !== null && typeof sprintId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`sprintId` must be a string or null.' },
      { status: 400 },
    );
  }
  if (beforeId !== undefined && typeof beforeId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`beforeId` must be a string.' },
      { status: 400 },
    );
  }
  if (afterId !== undefined && typeof afterId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`afterId` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const item =
      sprintId === null
        ? await backlogService.moveToBacklog(id, ctx)
        : await backlogService.assignToSprint(id, sprintId, { beforeId, afterId }, ctx);
    return NextResponse.json(item);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError || err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof CrossProjectSprintAssignmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
