import { NextResponse } from 'next/server';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The AI routes' share of the MOTIR-2291 split (Subtasks MOTIR-2355 / -2357 /
// -2358 / -2359).
//
// The planning services carried no assertion of their own: `aiPlanEditsService`,
// `aiExplanationService`, `aiGenerationService` and `aiSprintPlanningService`
// reached a gate, when they reached one at all, only through something else the
// route happened to call. Now every submission asks `ai:plan` through
// `projectAccessService.assertPermission`, which raises the two errors the shared
// gate raises everywhere else:
//
//   * `ProjectNotFoundError` for an actor who cannot BROWSE the project → 404,
//     the no-existence-leak posture;
//   * `PermissionDeniedError`, carrying the key → 403.
//
// The AI routes each already carry a credit / transport mapping of their own
// (402 out-of-credits, 502 upstream), so this returns null and lets them keep
// handling those — the same shape `projectErrorResponse`, `boardGateErrorResponse`
// and `sprintGateErrorResponse` use.
//
// ⚠️ WHY A 403 AND NOT A SILENT NO-OP. `ai:plan` is the one key in this story
// whose refusal a user is most likely to hit by surprise — a workspace member
// with no membership on this project could run the planner on it yesterday. The
// body names the permission so the client can say WHICH grant is missing rather
// than "something went wrong", which is what turns a support question into a
// role change.

/**
 * Map the AI project gate's two refusals to HTTP, or null so the caller keeps
 * handling its own domain errors.
 */
export function aiPlanGateErrorResponse(err: unknown): NextResponse | null {
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
