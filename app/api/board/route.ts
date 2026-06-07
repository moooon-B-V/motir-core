import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardNotFoundError,
  InvalidSwimlaneGroupByError,
  NotBoardAdminError,
} from '@/lib/boards/errors';

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

// PATCH /api/board (Subtask 3.3.3) — set the active project's board swimlane
// group-by. Body: { boardId, swimlaneGroupBy }. Thin HTTP layer over
// boardsService.setSwimlaneGroupBy; session-required; workspace from the
// active-project context (NEVER the client). `boardId` rides in the body — the
// same forward-compatible multi-board shape the move route uses (the client
// holds it from the GET projection). No db / no transaction here.
//
// Typed errors → status codes:
//   InvalidSwimlaneGroupByError → 400 (not a BoardSwimlaneGroupBy value)
//   NotBoardAdminError          → 403 (not the workspace owner — finding #36)
//   BoardNotFoundError          → 404 (unknown / cross-workspace board)

export async function PATCH(req: Request): Promise<Response> {
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

  const { boardId, swimlaneGroupBy } = (body ?? {}) as Record<string, unknown>;
  if (typeof boardId !== 'string' || typeof swimlaneGroupBy !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` and `swimlaneGroupBy` are required.' },
      { status: 400 },
    );
  }

  try {
    const board = await boardsService.setSwimlaneGroupBy(boardId, swimlaneGroupBy, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(board);
  } catch (err) {
    if (err instanceof InvalidSwimlaneGroupByError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
