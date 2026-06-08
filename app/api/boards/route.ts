import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  InvalidBoardNameError,
  InvalidBoardTypeError,
  NotBoardAdminError,
} from '@/lib/boards/errors';

// /api/boards (Subtask 3.7.3) — the multi-board CRUD collection for the ACTIVE
// project (the board lifecycle: list + create; per-board rename/set-default/
// delete live under /api/boards/[id]). Thin HTTP layer over boardsService;
// session-required; the project + workspace come from the active-project
// context (NEVER the client), like /api/board. No db / no transaction here
// (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[key]/boards): the app is single-
// active-project — /boards resolves getActiveProject() and there is no
// project-by-key route tree to mirror (same rationale as /api/board).

// GET /api/boards — the active project's boards as switcher rows
// (BoardSummaryDto[], ordered by position). Any member may read (the switcher
// is not a config write); the workspace gate is the active-project context.
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

  const boards = await boardsService.listBoards(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return NextResponse.json({ boards });
}

// POST /api/boards — create a board on the active project (seeds default
// columns off the workflow; non-default). Body: { name, type? } (type defaults
// to kanban). Returns 201 with the new board's switcher DTO.
//
// Typed errors → status codes:
//   InvalidBoardNameError / InvalidBoardTypeError → 400
//   NotBoardAdminError                            → 403 (not owner, #36; TODO(6.4))
//   ProjectNotFoundError                          → 404
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

  const { name, type } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`name` is required.' },
      { status: 400 },
    );
  }
  if (type !== undefined && typeof type !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`type` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const board = await boardsService.createBoard(
      ctx.projectId,
      { name, type },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return NextResponse.json(board, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidBoardNameError || err instanceof InvalidBoardTypeError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
