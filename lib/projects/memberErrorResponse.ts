import { NextResponse } from 'next/server';
import {
  AlreadyProjectMemberError,
  InvalidAccessLevelError,
  InvalidProjectRoleError,
  LastProjectAdminError,
  NotAProjectMemberError,
  NotProjectAdminError,
  ProjectNotFoundError,
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';

// Shared typed-error → HTTP-status translation for the project membership +
// access routes (Story 6.4 · 6.4.4). Keeps the three thin route files from
// duplicating the same eight branches. Returns a NextResponse for a known
// domain error, or null so the route rethrows (a genuine 500).
//
//   ProjectNotFoundError / NotAProjectMemberError        → 404 (incl. the
//       no-existence-leak 404 for a cross-tenant / unknown project key)
//   NotProjectAdminError                                 → 403
//   TargetNotWorkspaceMemberError / InvalidProjectRoleError
//       / InvalidAccessLevelError                        → 400
//   AlreadyProjectMemberError / LastProjectAdminError    → 409
export function projectMemberErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError || err instanceof NotAProjectMemberError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof NotProjectAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (
    err instanceof TargetNotWorkspaceMemberError ||
    err instanceof InvalidProjectRoleError ||
    err instanceof InvalidAccessLevelError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof AlreadyProjectMemberError || err instanceof LastProjectAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  return null;
}
