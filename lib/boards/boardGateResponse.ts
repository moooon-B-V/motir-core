import { NextResponse } from 'next/server';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The board routes' share of the MOTIR-2256 split (Subtask MOTIR-2296).
//
// Board configuration used to be gated by `boardsService`'s module-private
// `assertBoardConfigAdmin`, which threw `NotBoardAdminError` — one typed error,
// caught individually in seven route files. That gate is gone: every board-shape
// write now asks `projectAccessService.assertPermission(…, 'board:configure')`,
// which throws the two errors the shared gate throws everywhere else —
// `ProjectNotFoundError` for an actor who cannot BROWSE the project (404, the
// no-existence-leak posture; a settings surface a viewer cannot see must look
// missing, not forbidden) and `PermissionDeniedError` carrying the key for a
// browser who lacks it (403).
//
// Rather than paste both branches into seven catch blocks, they live here. Each
// route calls this FIRST and falls through to its own domain errors (invalid WIP
// limit, board not found, …) when it returns null — the same shape
// `projectErrorResponse` and `projectMemberErrorResponse` already use.
//
// ⚠️ `NotBoardAdminError` and its `NOT_BOARD_ADMIN` wire code are RETIRED by that
// card, not merely bypassed. Its message — "You must be a workspace owner to
// change board configuration." — became false the moment a project admin could
// configure a board, and `git grep NOT_BOARD_ADMIN` over app / lib / components /
// tests / e2e found it only inside the route files that raised it. Nothing
// outside this repo's own error plumbing ever read it.

/**
 * Map the shared permission gate's two refusals to HTTP, or null so the caller
 * keeps handling its own domain errors.
 */
export function boardGateErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  return null;
}
