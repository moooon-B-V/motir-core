import { NextResponse } from 'next/server';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The backlog / sprint routes' share of the MOTIR-2291 split (Subtask MOTIR-2350).
//
// `backlogService` shipped with NO project gate — the workspace-context tenancy
// check was the whole of its access boundary — so its routes have never had to
// map a project refusal. Now every grooming write asks `sprint:manage` and both
// bounded reads ask `project:browse` through
// `projectAccessService.assertPermission`, which throws the two errors the shared
// gate throws everywhere else:
//
//   * `ProjectNotFoundError` for an actor who cannot BROWSE the project → 404,
//     the no-existence-leak posture. A backlog a viewer-less actor may not see
//     must look missing, not forbidden.
//   * `PermissionDeniedError`, carrying the key that was missing → 403.
//
// Rather than paste both branches into seven catch blocks, they live here; each
// route calls this FIRST and falls through to its own domain errors (unknown
// sprint, oversize batch, cross-project assignment, …) when it returns null —
// the same shape `projectErrorResponse` and `boardGateErrorResponse` use.
//
// ⚠️ The sprint LIFECYCLE routes (`POST /api/sprints`, `PATCH`/`DELETE
// /api/sprints/[id]`, `/start`, `/complete`) deliberately do NOT use this. Their
// gate keeps raising `NotSprintAdminError` / `NOT_SPRINT_ADMIN`, because unlike
// the board's retired `NOT_BOARD_ADMIN` that code is read by three backlog
// dialogs, by `lib/api/v1/errors.ts`, and by the PUBLIC v1 API's own OpenAPI
// description — a documented contract error whose actor set moved while its shape
// did not. Those routes already catch it and need no change.

/**
 * Map the shared permission gate's two refusals to HTTP, or null so the caller
 * keeps handling its own domain errors.
 */
export function sprintGateErrorResponse(err: unknown): NextResponse | null {
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
