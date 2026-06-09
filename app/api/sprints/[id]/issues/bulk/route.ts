import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { backlogService } from '@/lib/services/backlogService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  BulkBatchTooLargeError,
  CrossProjectSprintAssignmentError,
  SprintNotFoundError,
} from '@/lib/sprints/errors';

// POST /api/sprints/[id]/issues/bulk (Subtask 4.2.2) — assign a multi-selection
// of issues to a sprint ATOMICALLY (the backlog's "Move to sprint ▸" bulk
// action). Thin HTTP layer over backlogService.bulkAssignToSprint: the sprint id
// is the path param, the workspace + actor come from the session context (the
// sprint names its OWN project, so no active-project coupling — same shape as the
// single-issue /api/work-items/[id]/sprint route). The whole batch moves in one
// transaction or none does. No db / no transaction here (CLAUDE.md).
//
// Body: { itemIds: string[] }  → bulkAssignToSprint
//
// Typed errors → status codes:
//   BulkBatchTooLargeError             → 400
//   SprintNotFoundError                → 404
//   WorkItemNotFoundError              → 404
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

  const { itemIds } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(itemIds) || !itemIds.every((x) => typeof x === 'string')) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`itemIds` must be an array of strings.' },
      { status: 400 },
    );
  }

  try {
    const items = await backlogService.bulkAssignToSprint(itemIds as string[], id, ctx);
    return NextResponse.json({ items });
  } catch (err) {
    if (err instanceof BulkBatchTooLargeError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof WorkItemNotFoundError || err instanceof SprintNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof CrossProjectSprintAssignmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
