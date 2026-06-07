import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardColumnNotFoundError,
  ColumnNotEmptyError,
  InvalidColumnNameError,
  InvalidColumnPositionError,
  InvalidWipLimitError,
  LastColumnError,
  NotBoardAdminError,
} from '@/lib/boards/errors';

// PATCH /api/board/columns/[columnId] — mutate one of a board column's
// attributes. ONE attribute per request (the 3.6.3 UI sends a single edit at a
// time), routed to a single service method per CLAUDE.md (one service call per
// happy-path branch):
//   - { wipLimit: number | null }  → setColumnWipLimit (Subtask 3.3.3)
//   - { name: string }             → renameColumn      (Subtask 3.6.2)
//   - { position: string }         → reorderColumn     (Subtask 3.6.2 — the
//       opaque fractional-index key the client mints between two neighbours)
//
// DELETE /api/board/columns/[columnId] — delete the column (Subtask 3.6.2). It
// unmaps the column's statuses (they return to the unmapped-statuses tray) and
// deletes the column; it is refused when the column is the board's last, or
// when a mapped status still holds work items (remap first). No work item is
// ever deleted.
//
// Thin HTTP layer over boardsService; session-required; workspace from the
// active-project context (NEVER the client). The column id is the path param,
// workspace-scoped + tenant-gated in the service (the column row carries its own
// project/workspace), so no `boardId` is needed. No db / no transaction here.
//
// Typed errors → status codes:
//   InvalidWipLimitError / InvalidColumnNameError / InvalidColumnPositionError → 400
//   NotBoardAdminError                                                         → 403
//   BoardColumnNotFoundError                                                   → 404
//   LastColumnError / ColumnNotEmptyError                                      → 409

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
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { wipLimit, name, position } = (body ?? {}) as Record<string, unknown>;

  try {
    // WIP limit (Subtask 3.3.3). `wipLimit` may legitimately be null (clear),
    // so branch on the key being PRESENT, not on truthiness.
    if ('wipLimit' in (body as object)) {
      if (wipLimit !== null && typeof wipLimit !== 'number') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`wipLimit` must be a number or null.' },
          { status: 400 },
        );
      }
      const column = await boardsService.setColumnWipLimit(columnId, wipLimit, serviceCtx);
      return NextResponse.json(column);
    }

    // Rename (Subtask 3.6.2).
    if (name !== undefined) {
      if (typeof name !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`name` must be a string.' },
          { status: 400 },
        );
      }
      const column = await boardsService.renameColumn(columnId, name, serviceCtx);
      return NextResponse.json(column);
    }

    // Reorder (Subtask 3.6.2).
    if (position !== undefined) {
      if (typeof position !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`position` must be a string.' },
          { status: 400 },
        );
      }
      const column = await boardsService.reorderColumn(columnId, position, serviceCtx);
      return NextResponse.json(column);
    }

    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected one of `wipLimit`, `name`, or `position`.' },
      { status: 400 },
    );
  } catch (err) {
    if (
      err instanceof InvalidWipLimitError ||
      err instanceof InvalidColumnNameError ||
      err instanceof InvalidColumnPositionError
    ) {
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

export async function DELETE(
  _req: Request,
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

  try {
    await boardsService.deleteColumn(columnId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotBoardAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof BoardColumnNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof LastColumnError || err instanceof ColumnNotEmptyError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    throw err;
  }
}
