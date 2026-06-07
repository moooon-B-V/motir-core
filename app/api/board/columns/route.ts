import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardNotFoundError,
  InvalidColumnNameError,
  NotBoardAdminError,
} from '@/lib/boards/errors';

// POST /api/board/columns (Subtask 3.6.2) — add a column to the active
// project's board. Body: { boardId, name, position? }. Thin HTTP layer over
// boardsService.addColumn; session-required; workspace from the active-project
// context (NEVER the client). `boardId` rides in the body — the same forward-
// compatible multi-board shape the move / group-by routes use (the client holds
// it from the GET projection). No db / no transaction here (CLAUDE.md).
//
// Typed errors → status codes:
//   InvalidColumnNameError → 400 (empty / whitespace name)
//   NotBoardAdminError     → 403 (not the workspace owner — finding #36)
//   BoardNotFoundError     → 404 (unknown / cross-workspace board)

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

  const { boardId, name, position } = (body ?? {}) as Record<string, unknown>;
  if (typeof boardId !== 'string' || typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` and `name` are required.' },
      { status: 400 },
    );
  }
  if (position !== undefined && typeof position !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`position` must be a string when provided.' },
      { status: 400 },
    );
  }

  try {
    const column = await boardsService.addColumn(
      boardId,
      { name, position },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(column, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidColumnNameError) {
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
