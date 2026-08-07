import { NextResponse } from 'next/server';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  CustomFieldNotFoundError,
  CustomFieldOptionNotFoundError,
  FieldKeyConflictError,
  FieldLimitReachedError,
  InvalidFieldLabelError,
  InvalidFieldTypeError,
  InvalidPositionError,
  NotASelectFieldError,
  OptionInUseError,
  OptionLimitReachedError,
} from '@/lib/customFields/errors';

// Shared typed-error → HTTP-status translation for the custom-fields routes
// (Story 5.3 · Subtask 5.3.2) — keeps the four thin route files from
// duplicating the same branches (the projectMemberErrorResponse pattern).
// Returns a NextResponse for a known domain error, or null so the route
// rethrows (a genuine 500).
//
//   ProjectNotFoundError / CustomFieldNotFoundError /
//     CustomFieldOptionNotFoundError /
//     ProjectAccessDeniedError(kind: browse)              → 404 (no
//       existence leak — cross-workspace ids and hidden projects are
//       indistinguishable from never-existed ones, findings #26/#44)
//   NotProjectAdminError / ProjectAccessDeniedError(edit) → 403
//   InvalidFieldTypeError / InvalidFieldLabelError /
//     NotASelectFieldError / InvalidPositionError         → 400
//   OptionInUseError / FieldKeyConflictError              → 409
//   FieldLimitReachedError / OptionLimitReachedError      → 422 (the caps)
export function customFieldErrorResponse(err: unknown): NextResponse | null {
  if (
    err instanceof ProjectNotFoundError ||
    err instanceof CustomFieldNotFoundError ||
    err instanceof CustomFieldOptionNotFoundError ||
    (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  // MOTIR-2256 — the domain gate now asks `assertPermission(…, '<key>')`, which
  // refuses with `PermissionDeniedError` carrying the key. It maps to the SAME
  // 403 `NotProjectAdminError` did; the body gains `permission`. Both arms stay:
  // `project:administer` still raises the old error (the compatibility branch in
  // `projectAccessService.assertPermission`).
  if (
    err instanceof PermissionDeniedError ||
    err instanceof NotProjectAdminError ||
    err instanceof ProjectAccessDeniedError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (
    err instanceof InvalidFieldTypeError ||
    err instanceof InvalidFieldLabelError ||
    err instanceof NotASelectFieldError ||
    err instanceof InvalidPositionError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof OptionInUseError || err instanceof FieldKeyConflictError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  if (err instanceof FieldLimitReachedError || err instanceof OptionLimitReachedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
  }
  return null;
}
