import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import { BoardNotFoundError, NotBoardAdminError } from '@/lib/boards/errors';

// DELETE /api/board/columns/[columnId]/statuses/[statusId] (Subtask 3.6.2) —
// unmap a workflow status from the board: delete its column mapping so it
// returns to the unmapped-statuses tray (3.2.6); its work items are hidden from
// the board, never deleted. Thin HTTP layer over boardsService.unmapStatus;
// session-required; workspace from the active-project context (NEVER the
// client). Idempotent: unmapping an already-unmapped status is a 204 no-op.
//
// `boardId` rides in the query string (a DELETE carries no body) — the client
// holds it from the GET projection; the service scopes the unmap to that board
// (a status maps per board). The `columnId` path segment addresses the mapping
// resource RESTfully; the unmap itself is keyed by (boardId, statusId) since a
// status maps to at most one column per board. No db / no transaction here.
//
// Typed errors → status codes:
//   NotBoardAdminError  → 403
//   BoardNotFoundError  → 404 (unknown / cross-workspace board)

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ columnId: string; statusId: string }> },
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

  const { statusId } = await params;
  const boardId = new URL(req.url).searchParams.get('boardId');
  if (!boardId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` query parameter is required.' },
      { status: 400 },
    );
  }

  try {
    await boardsService.unmapStatus(boardId, statusId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
