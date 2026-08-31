import { NextResponse } from 'next/server';
import {
  AlreadyProjectMemberError,
  InvalidAccessLevelError,
  InvalidProjectRoleError,
  LastProjectAdminError,
  NotAProjectMemberError,
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectNotFoundError,
  PublicAccessUnavailableError,
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';
import { RoleDefinitionNotFoundError } from '@/lib/permissions/errors';

// Shared typed-error → HTTP-status translation for the project membership +
// access routes (Story 6.4 · 6.4.4). Keeps the three thin route files from
// duplicating the same eight branches. Returns a NextResponse for a known
// domain error, or null so the route rethrows (a genuine 500).
//
//   ProjectNotFoundError / NotAProjectMemberError        → 404 (incl. the
//       no-existence-leak 404 for a cross-tenant / unknown project key)
//   RoleDefinitionNotFoundError                          → 404 (MOTIR-2485 — a
//       role definition id naming another project's or another workspace's role,
//       under the SAME no-existence-leak posture: it must be indistinguishable
//       from an id that never existed, so PATCH can't probe a foreign role.)
//   NotProjectAdminError / PermissionDeniedError         → 403 (MOTIR-2295 —
//       these routes now gate on `member:manage` / `project:manage_access` /
//       `project:browse` through the shared `assertPermission`, so the refusal
//       arrives as PermissionDeniedError carrying the key. NotProjectAdminError
//       stays mapped: `assertPermission` still throws it for `project:administer`,
//       and other callers of this mapper may raise it.)
//   TargetNotWorkspaceMemberError / InvalidProjectRoleError
//       / InvalidAccessLevelError / PublicAccessUnavailableError → 400
//   AlreadyProjectMemberError / LastProjectAdminError    → 409
export function projectMemberErrorResponse(err: unknown): NextResponse | null {
  if (
    err instanceof ProjectNotFoundError ||
    err instanceof NotAProjectMemberError ||
    err instanceof RoleDefinitionNotFoundError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { error: err.message, code: err.code, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof NotProjectAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (
    err instanceof TargetNotWorkspaceMemberError ||
    err instanceof InvalidProjectRoleError ||
    err instanceof InvalidAccessLevelError ||
    // MOTIR-4035 — `public` is not an assignable level on a self-hosted build.
    // 400 rather than 404, and the difference is the SUBJECT: the public READ
    // surface is absent, so it answers 404 (there is no door); this route is
    // present and still sets open / limited / private, and refuses ONE argument.
    // A 404 here would say the project does not exist to a caller who is looking
    // at it, which is a worse lie than the one it would be avoiding.
    err instanceof PublicAccessUnavailableError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof AlreadyProjectMemberError || err instanceof LastProjectAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  return null;
}
