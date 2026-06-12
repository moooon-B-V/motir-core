import { NextResponse } from 'next/server';
import {
  AliasNotFoundError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAvatarError,
  InvalidIdentifierError,
  InvalidProjectNameError,
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';

// Shared typed-error → HTTP-status translation for the project-details +
// change-key routes (Story 6.8 · Subtask 6.8.1). Keeps the PATCH
// /api/projects/[key] + DELETE .../aliases/[alias] route files thin. Returns a
// NextResponse for a known domain error, or null so the route rethrows (a
// genuine 500).
//
//   ProjectNotFoundError / AliasNotFoundError                → 404 (incl. the
//       no-existence-leak 404 a non-browser sees instead of "exists but you
//       can't" — assertCanManage maps a non-browser to ProjectNotFoundError)
//   ProjectAccessDeniedError / NotProjectAdminError          → 403
//   InvalidProjectNameError / InvalidIdentifierError
//       / IdentifierUnchangedError / InvalidAvatarError       → 400
//   IdentifierTakenError / IdentifierReservedError           → 409
export function projectErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError || err instanceof AliasNotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError || err instanceof NotProjectAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (
    err instanceof InvalidProjectNameError ||
    err instanceof InvalidIdentifierError ||
    err instanceof IdentifierUnchangedError ||
    err instanceof InvalidAvatarError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof IdentifierTakenError || err instanceof IdentifierReservedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  return null;
}
