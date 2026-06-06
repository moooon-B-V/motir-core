import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import { BoardColumnNotFoundError, BoardNotFoundError } from '@/lib/boards/errors';

// GET /api/board/columns/[columnId]/cards?boardId=&cursor= (Subtask 3.1.6) — the
// lazy "load more" page for one column (PagedColumnCardsDto: the next slice of
// cards + the cursor after it). Thin HTTP layer over boardsService.loadColumn-
// Cards; session-required; project/workspace from the active-project context.
//
// `boardId` is a required query param — the client already holds it from the
// GET /api/board projection (the forward-compatible multi-board shape; v1 has
// one board per project). The page size is the projection's constant, so there
// is no `limit` param. The service tenant-gates both the board and the column.

export async function GET(
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
  const boardId = new URL(req.url).searchParams.get('boardId');
  const cursor = new URL(req.url).searchParams.get('cursor');
  if (!boardId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A `boardId` query param is required.' },
      { status: 400 },
    );
  }

  try {
    const page = await boardsService.loadColumnCards(boardId, columnId, cursor, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof BoardNotFoundError || err instanceof BoardColumnNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
