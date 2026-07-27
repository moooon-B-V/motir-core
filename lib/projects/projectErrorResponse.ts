import { NextResponse } from 'next/server';
import {
  AliasNotFoundError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAiSettingsError,
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
//   InvalidAiSettingsError                                   → 422 (Story 7.13 ·
//       MOTIR-915 — a well-formed patch carrying an out-of-range threshold /
//       sprint length or a malformed planner-model override; the value semantics
//       are wrong, so it is the same 422 family as InvalidScaleConfigError, not a
//       400 malformed-body)
export function projectErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof InvalidAiSettingsError) {
    return NextResponse.json(
      { error: err.message, code: err.code, field: err.field },
      { status: 422 },
    );
  }
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
