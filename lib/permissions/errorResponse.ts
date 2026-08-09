import { NextResponse } from 'next/server';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  BuiltInRoleImmutableError,
  InvalidRoleBaseError,
  InvalidRoleNameError,
  InvalidRoleReassignTargetError,
  RoleDefinitionNotFoundError,
  RoleInUseError,
  RoleLimitReachedError,
  RoleNameTakenError,
  UngrantablePermissionError,
} from '@/lib/permissions/errors';

// Shared typed-error → HTTP-status translation for the role-definition routes
// (Story MOTIR-2257 · Subtask MOTIR-2474) — ONE module, so no route decides a
// status itself and the three handlers cannot drift. The
// `customFieldErrorResponse` / `projectMemberErrorResponse` pattern.
//
// Returns a NextResponse for a known domain refusal, or null so the route
// rethrows (a genuine 500).
//
//   ProjectNotFoundError / RoleDefinitionNotFoundError /
//     ProjectAccessDeniedError(browse)                     → 404
//   PermissionDeniedError / NotProjectAdminError /
//     ProjectAccessDeniedError(edit)                       → 403
//   BuiltInRoleImmutableError                              → 403
//   RoleNameTakenError / RoleLimitReachedError /
//     RoleInUseError                                       → 409
//   InvalidRoleNameError / InvalidRoleBaseError /
//     UngrantablePermissionError /
//     InvalidRoleReassignTargetError                       → 400
export function roleDefinitionErrorResponse(err: unknown): NextResponse | null {
  // ⚠️ 404 BEFORE 403, ALWAYS. A settings surface must never be usable to
  // confirm that a foreign project exists — a cross-workspace id and a
  // never-existed one are indistinguishable (finding #26). The service's own
  // ordering produces this; the map only has to preserve it.
  if (
    err instanceof ProjectNotFoundError ||
    err instanceof RoleDefinitionNotFoundError ||
    (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }

  // ⚠️ A BUILT-IN IS A REFUSAL, NOT A CONFLICT AND NOT A NOT-FOUND. `admin` /
  // `member` / `viewer` exist and may never be written, so the caller asked for
  // something meaningful and impossible. 409 would imply "try again differently";
  // 404 would deny that the role exists, which is a lie the page can see through.
  if (err instanceof BuiltInRoleImmutableError) {
    return NextResponse.json(
      { error: err.message, code: err.code, role: err.role },
      { status: 403 },
    );
  }

  // The gate's own refusal carries WHICH grant was missing — its own arm rather
  // than a third alternative on the one below, because a shared arm returns the
  // right status and silently drops `permission` (the MOTIR-2256 lesson).
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { error: err.message, code: err.code, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof NotProjectAdminError || err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }

  // ⚠️ THE IN-USE REFUSAL CARRIES THE MEMBER COUNT ACROSS THE WIRE. It is not
  // decoration and it is not re-derivable by the client: the delete dialog
  // (`design/projects/roles-permissions.mock.html` panel 5) names how many people
  // are affected BEFORE it asks where they should go, and this response is where
  // that number comes from. Dropping it would force a second question the user
  // has no way to answer.
  if (err instanceof RoleInUseError) {
    return NextResponse.json(
      { error: err.message, code: err.code, count: err.count, roleName: err.roleName },
      { status: 409 },
    );
  }
  if (err instanceof RoleNameTakenError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  // The cap is a CONFLICT with the project's current state, not a malformed
  // request — the same 409 the shipped `OptionInUseError` / `FieldKeyConflictError`
  // take. It carries the limit so the page can say what it is.
  if (err instanceof RoleLimitReachedError) {
    return NextResponse.json(
      { error: err.message, code: err.code, limit: err.limit },
      { status: 409 },
    );
  }

  if (
    err instanceof InvalidRoleNameError ||
    err instanceof InvalidRoleBaseError ||
    err instanceof UngrantablePermissionError ||
    err instanceof InvalidRoleReassignTargetError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }

  return null;
}
