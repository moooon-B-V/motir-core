import { NextResponse } from 'next/server';
import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  StatusMappingConflictError,
} from '@/lib/boards/errors';
import { WorkflowStatusNotFoundError } from '@/lib/workflows/errors';
import { boardGateErrorResponse } from '@/lib/boards/boardGateResponse';

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
//   PermissionDeniedError (board:configure)                     → 403
//   ProjectNotFoundError (cannot browse the project)             → 404
//   BoardNotFoundError / BoardColumnNotFoundError       → 404
//   WorkflowStatusNotFoundError                         → 404
//   StatusMappingConflictError                          → 409

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ columnId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  // The 2FA hold (MOTIR-3653) — placed AFTER the no-project arm, which keeps
  // its own answer. `ctx.userId` is the session user `getWorkspaceContext`
  // already resolved, so this costs one policy query and no second auth trip.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

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
    const gate = boardGateErrorResponse(err);
    if (gate) return gate;
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
