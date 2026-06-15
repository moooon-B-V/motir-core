import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { boardsService } from '@/lib/services/boardsService';
import {
  BoardNotFoundError,
  InvalidBoardNameError,
  InvalidSwimlaneGroupByError,
  NotBoardAdminError,
} from '@/lib/boards/errors';
import { decodeFilterParam } from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';
import { SavedFilterNotFoundError } from '@/lib/savedFilters/errors';
import type { BoardFilterInput } from '@/lib/dto/boards';

// GET /api/board (Subtask 3.1.6) — the board projection for the ACTIVE project's
// default board: a BoardProjectionDto (columns in workflow order, each with a
// bounded first page of cards + count + cursor, plus unmappedStatuses). Thin
// HTTP layer over boardsService.getBoard; session-required; the project +
// workspace come from the active-project context (NEVER the client). No db / no
// transaction here (CLAUDE.md).
//
// Active-project routing (NOT /api/projects/[key]/board): the app is single-
// active-project — the /boards and /issues pages both resolve getActiveProject()
// and there is no project-by-key route tree to mirror. The project + workspace
// come from the active-project context (NEVER the client).
//
// Board SELECTION (Subtask 3.7.5): a `?boardId=` query param picks WHICH of the
// active project's boards to project; absent → the project's DEFAULT board (the
// pre-3.7 single-board behaviour, unchanged). The board page (`/boards`) carries
// its `?board=` selection here as `?boardId=`. The service tenant-gates the id
// to the active project/workspace (a stale / cross-project id → 404), so the
// param is safe to take from the client.
//
// Board FILTER (Story 6.15 · 6.15.2 read + 6.15.3 wiring): a `?filter=v1:` query
// param carries the COMPILED filter AST (the board page merges the toolbar's
// facets + advanced `?filter=` into one AST via `upgradeFacetsIntoAst`, then
// encodes it here). It's decoded with the SAME `decodeFilterParam` codec the
// /issues navigator uses (one codec, two carriers) and threaded to
// `getBoard` as a `BoardFilterInput.ast`, which narrows every column + the
// cap/`truncated` count + swimlane lanes and composes with the Scrum sprint
// scope. A malformed/forged param decodes to `!ok` → treated as NO filter (the
// unfiltered projection — the page only ever emits a valid param, so this is the
// forged-URL degrade, mirroring the navigator's recoverable-state handling).
// `getBoard` re-validates the AST against the registry, so a structurally-valid
// but semantically-bad condition throws `FilterValidationError` → 422.

export async function GET(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const params = new URL(req.url).searchParams;
  const boardId = params.get('boardId')?.trim() || undefined;

  // Decode the optional compiled-filter param. A bad decode → no filter (the
  // graceful degrade, not a 400): the page never emits a malformed param, so
  // this only guards a hand-forged URL, which should show the full board.
  const rawFilter = params.get('filter')?.trim() || undefined;
  let filter: BoardFilterInput | undefined;
  if (rawFilter) {
    const decoded = decodeFilterParam(rawFilter);
    if (decoded.ok && decoded.ast.conditions.length > 0) filter = { ast: decoded.ast };
  }

  try {
    const board = await boardsService.getBoard(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      boardId,
      filter,
    );
    return NextResponse.json(board);
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    // An inline filter AST that fails registry validation (6.1.1) → 422.
    if (err instanceof FilterValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // A saved-filter id that resolves to nothing/unauthorized (only reachable
    // via `BoardFilterInput.savedFilterId`, which this route does not currently
    // emit — mapped for the service's full contract) → 404.
    if (err instanceof SavedFilterNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}

// PATCH /api/board — mutate one of the active project's board attributes. ONE
// attribute per request, routed to a single service method (one service call
// per happy-path branch, CLAUDE.md):
//   - { boardId, swimlaneGroupBy } → setSwimlaneGroupBy (Subtask 3.3.3)
//   - { boardId, name }            → renameBoard        (Subtask 3.6.2)
// Thin HTTP layer over boardsService; session-required; workspace from the
// active-project context (NEVER the client). `boardId` rides in the body — the
// same forward-compatible multi-board shape the move route uses (the client
// holds it from the GET projection). No db / no transaction here.
//
// Typed errors → status codes:
//   InvalidSwimlaneGroupByError / InvalidBoardNameError → 400
//   NotBoardAdminError                                  → 403 (not owner, #36)
//   BoardNotFoundError                                  → 404 (unknown board)

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

  const { boardId, swimlaneGroupBy, name } = (body ?? {}) as Record<string, unknown>;
  if (typeof boardId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`boardId` is required.' },
      { status: 400 },
    );
  }
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  try {
    if (swimlaneGroupBy !== undefined) {
      if (typeof swimlaneGroupBy !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`swimlaneGroupBy` must be a string.' },
          { status: 400 },
        );
      }
      const board = await boardsService.setSwimlaneGroupBy(boardId, swimlaneGroupBy, serviceCtx);
      return NextResponse.json(board);
    }

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`name` must be a string.' },
          { status: 400 },
        );
      }
      const board = await boardsService.renameBoard(boardId, name, serviceCtx);
      return NextResponse.json(board);
    }

    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected one of `swimlaneGroupBy` or `name`.' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof InvalidSwimlaneGroupByError || err instanceof InvalidBoardNameError) {
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
