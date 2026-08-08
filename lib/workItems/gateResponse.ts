import { NextResponse } from 'next/server';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The work-item routes' share of MOTIR-2291's CLAIMED_BUT_UNVERIFIED sweep
// (Subtasks MOTIR-2365 / MOTIR-2366).
//
// Five operations the inventory labelled `existing` turned out to have only a
// WORKSPACE check behind them — the estimate write, the parent roll-up, the
// activity history, and both acceptance-evidence paths, of which the upload-token
// minter was reachable with a session and a story id alone. Each now asserts its
// row's key on the project resolved from the WORK ITEM, which raises the two
// errors the shared gate raises everywhere else:
//
//   * `ProjectNotFoundError` for an actor who cannot BROWSE the project → 404;
//   * `PermissionDeniedError`, carrying the key → 403.
//
// Their routes had never needed a project-refusal arm, so it lives here rather
// than pasted into five catch blocks — the same shape `projectErrorResponse`,
// `boardGateErrorResponse` and `sprintGateErrorResponse` use.

/**
 * Map the shared permission gate's two refusals to HTTP, or null so the caller
 * keeps handling its own domain errors.
 */
export function workItemGateErrorResponse(err: unknown): NextResponse | null {
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
