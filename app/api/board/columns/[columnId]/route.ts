import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardColumnNotFoundError,
  InvalidWipLimitError,
  NotBoardAdminError,
} from '@/lib/boards/errors';

// PATCH /api/board/columns/[columnId] (Subtask 3.3.3) — set (or clear) a board
// column's WIP limit. Body: { wipLimit: number | null }. Thin HTTP layer over
// boardsService.setColumnWipLimit; session-required; workspace from the active-
// project context (NEVER the client). The column id is the path param and is
// workspace-scoped + tenant-gated in the service, so no `boardId` is needed
// (the column row carries its own project/workspace). No db / no transaction.
//
// `wipLimit` must be a number or null at the transport layer (a non-negative
// INTEGER is validated in the service — a negative / fractional value is a
// typed 400, not a malformed body). Sits alongside the existing
// `columns/[columnId]/cards` GET route (the load-more page).
//
// Typed errors → status codes:
//   InvalidWipLimitError      → 400 (negative / non-integer limit)
//   NotBoardAdminError        → 403 (not the workspace owner — finding #36)
//   BoardColumnNotFoundError  → 404 (unknown / cross-workspace column)

export async function PATCH(
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

  const { wipLimit } = (body ?? {}) as Record<string, unknown>;
  if (wipLimit !== null && typeof wipLimit !== 'number') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`wipLimit` must be a number or null.' },
      { status: 400 },
    );
  }

  try {
    const column = await boardsService.setColumnWipLimit(columnId, wipLimit, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(column);
  } catch (err) {
    if (err instanceof InvalidWipLimitError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof BoardColumnNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
