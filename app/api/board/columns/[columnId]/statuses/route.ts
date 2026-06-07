import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  NotBoardAdminError,
  StatusMappingConflictError,
} from '@/lib/boards/errors';
import { WorkflowStatusNotFoundError } from '@/lib/workflows/errors';

// PUT /api/board/columns/[columnId]/statuses (Subtask 3.6.2) — map (or MOVE) a
// workflow status onto this column. Body: { boardId, statusId }. Thin HTTP layer
// over boardsService.mapStatusToColumn; session-required; workspace from the
// active-project context (NEVER the client). The mapping is a MOVE — a status
// lives in at most one column per board (`@@unique([boardId, statusId])`), so
// re-mapping replaces its prior column. No db / no transaction here.
//
// The column id is the path param; `boardId` rides in the body (the same
// multi-board-forward shape the other board writes use — the client holds it
// from the GET projection) so the service can scope the move-not-duplicate
// delete to this board.
//
// Typed errors → status codes:
//   NotBoardAdminError                                  → 403
//   BoardNotFoundError / BoardColumnNotFoundError       → 404
//   WorkflowStatusNotFoundError                         → 404
//   StatusMappingConflictError                          → 409

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ columnId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const { columnId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { boardId, statusId } = (body ?? {}) as Record<string, unknown>;
  if (typeof boardId !== 'string' || typeof statusId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` and `statusId` are required.' },
      { status: 400 },
    );
  }

  try {
    const mapping = await boardsService.mapStatusToColumn(boardId, columnId, statusId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(mapping);
  } catch (err) {
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (
      err instanceof BoardNotFoundError ||
      err instanceof BoardColumnNotFoundError ||
      err instanceof WorkflowStatusNotFoundError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof StatusMappingConflictError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
