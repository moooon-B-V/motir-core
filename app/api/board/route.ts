import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import { BoardNotFoundError } from '@/lib/boards/errors';

// GET /api/board (Subtask 3.1.6) — the board projection for the ACTIVE project's
// default board: a BoardProjectionDto (columns in workflow order, each with a
// bounded first page of cards + count + cursor, plus unmappedStatuses). Thin
// HTTP layer over boardsService.getBoard; session-required; the project +
// workspace come from the active-project context (NEVER the client). No db / no
// transaction here (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[key]/board): the app is single-
// active-project — the /boards and /issues pages both resolve getActiveProject()
// and there is no project-by-key route tree to mirror. The board id is implicit
// (the project's one default board); multi-board routing stays a later, non-
// breaking addition (the service already takes a boardId, surfaced in the
// projection for the column/move routes to echo back).

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  try {
    const board = await boardsService.getBoard(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(board);
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
