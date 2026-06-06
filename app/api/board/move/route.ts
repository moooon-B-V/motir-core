import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  IllegalBoardMoveError,
  UnmappedColumnTargetError,
} from '@/lib/boards/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/board/move (Subtask 3.1.6) — move a card on the board. Body:
// { boardId, workItemId, toColumnId, beforeId?, afterId? }. Thin HTTP layer over
// boardsService.moveCard (cross-column move = a validated workflow transition;
// in-column = a rank change). Session-required; project/workspace from the
// active-project context. No db / no transaction here (the service owns the tx).
//
// Typed errors → the status codes the 3.2 UI branches on:
//   IllegalBoardMoveError    → 409  (illegal transition — the snap-back signal)
//   UnmappedColumnTargetError → 422 (the target column maps no live status)
//   Board/Column/WorkItem not found → 404
// `boardId` rides in the body (the client holds it from the projection — the
// forward-compatible multi-board shape).

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { boardId, workItemId, toColumnId, beforeId, afterId } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof boardId !== 'string' ||
    typeof workItemId !== 'string' ||
    typeof toColumnId !== 'string'
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId`, `workItemId`, and `toColumnId` are required.' },
      { status: 400 },
    );
  }

  try {
    const result = await boardsService.moveCard(
      boardId,
      workItemId,
      {
        toColumnId,
        beforeId: typeof beforeId === 'string' ? beforeId : undefined,
        afterId: typeof afterId === 'string' ? afterId : undefined,
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof IllegalBoardMoveError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof UnmappedColumnTargetError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    if (
      err instanceof BoardNotFoundError ||
      err instanceof BoardColumnNotFoundError ||
      err instanceof WorkItemNotFoundError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
