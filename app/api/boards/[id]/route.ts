import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardNotFoundError,
  InvalidBoardNameError,
  LastBoardError,
  NotBoardAdminError,
} from '@/lib/boards/errors';

// /api/boards/[id] (Subtask 3.7.3) — per-board lifecycle mutations:
//   PATCH  { name }            → renameBoard      (3.6.2, reused)
//   PATCH  { isDefault: true } → setDefaultBoard
//   DELETE                     → deleteBoard      (guards: last-board, promote-default)
// Thin HTTP layer over boardsService; session-required; workspace from the
// active-project context (NEVER the client). The board id is the path param;
// the service tenant-gates it (a board outside the active workspace is a 404).
// No db / no transaction here (CLAUDE.md).

// PATCH /api/boards/[id] — ONE attribute per request, routed to a single
// service method (one service call per happy-path branch):
//   { name }            → renameBoard
//   { isDefault: true } → setDefaultBoard
//
// Typed errors → status codes:
//   InvalidBoardNameError → 400
//   NotBoardAdminError    → 403 (not owner, #36; TODO(6.4))
//   BoardNotFoundError    → 404
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
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

  const { name, isDefault } = (body ?? {}) as Record<string, unknown>;
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  try {
    if (name !== undefined) {
      if (typeof name !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`name` must be a string.' },
          { status: 400 },
        );
      }
      const board = await boardsService.renameBoard(id, name, serviceCtx);
      return NextResponse.json(board);
    }

    if (isDefault !== undefined) {
      if (isDefault !== true) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`isDefault` may only be set to true (promote a board).' },
          { status: 400 },
        );
      }
      const board = await boardsService.setDefaultBoard(id, serviceCtx);
      return NextResponse.json(board);
    }

    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected one of `name` or `isDefault`.' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof InvalidBoardNameError) {
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

// DELETE /api/boards/[id] — delete a board (its issues survive on the project).
// Returns 204 on success.
//
// Typed errors → status codes:
//   NotBoardAdminError → 403 (not owner, #36; TODO(6.4))
//   BoardNotFoundError → 404
//   LastBoardError     → 409 (a project must keep at least one board)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
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

  const { id } = await params;

  try {
    await boardsService.deleteBoard(id, { userId: ctx.userId, workspaceId: ctx.workspaceId });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof LastBoardError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
