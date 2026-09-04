import { NextResponse } from 'next/server';
import {
  AliasNotFoundError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAiSettingsError,
  InvalidIdentifierError,
  InvalidProjectImageError,
  InvalidProjectNameError,
  InvalidStatusAutomationSettingsError,
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  ProjectOverviewTooLongError,
  ProjectTaglineTooLongError,
  ProjectTagsInvalidError,
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
//   ProjectAccessDeniedError / NotProjectAdminError
//       / PermissionDeniedError                              → 403 (MOTIR-2293 —
//       PermissionDeniedError carries the `permission` that was missing, so the
//       body adds it; the other two keep the shape they shipped with)
//   InvalidProjectNameError / InvalidIdentifierError
//       / IdentifierUnchangedError / InvalidProjectImageError
//       / InvalidProjectImageError                            → 400
//   IdentifierTakenError / IdentifierReservedError           → 409
//   InvalidAiSettingsError                                   → 422 (Story 7.13 ·
//       MOTIR-915 — a well-formed patch carrying an out-of-range threshold /
//       sprint length or a malformed planner-model override; the value semantics
//       are wrong, so it is the same 422 family as InvalidScaleConfigError, not a
//       400 malformed-body)
//   InvalidStatusAutomationSettingsError                     → 422 (MOTIR-1618 —
//       a non-boolean for one of the two status-derivation switches; same 422
//       family, same `field` payload)
export function projectErrorResponse(err: unknown): NextResponse | null {
  // The public hero's three FIELD errors (MOTIR-4171). Each names the field it
  // refuses — `field` is the body key the `public-overview` PATCH takes — so the
  // Public page room can land the refusal under that field's own slot (the
  // AI-settings 422 idiom above, `AiPlanningSettingsEditor.tsx`) instead of a
  // generic toast. Until this arm existed the three surfaced as an unmapped
  // throw, i.e. a 500, from the one route that reaches them.
  if (err instanceof ProjectOverviewTooLongError) {
    return NextResponse.json(
      { error: err.message, code: err.code, field: 'publicOverviewMd', max: err.max },
      { status: 422 },
    );
  }
  if (err instanceof ProjectTaglineTooLongError) {
    return NextResponse.json(
      { error: err.message, code: err.code, field: 'publicTagline', max: err.max },
      { status: 422 },
    );
  }
  if (err instanceof ProjectTagsInvalidError) {
    return NextResponse.json(
      { error: err.message, code: err.code, field: 'publicTags', reason: err.reason },
      { status: 422 },
    );
  }
  if (
    err instanceof InvalidAiSettingsError ||
    err instanceof InvalidStatusAutomationSettingsError
  ) {
    return NextResponse.json(
      { error: err.message, code: err.code, field: err.field },
      { status: 422 },
    );
  }
  if (err instanceof ProjectNotFoundError || err instanceof AliasNotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { error: err.message, code: err.code, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof ProjectAccessDeniedError || err instanceof NotProjectAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (
    err instanceof InvalidProjectNameError ||
    err instanceof InvalidIdentifierError ||
    err instanceof IdentifierUnchangedError ||
    err instanceof InvalidProjectImageError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof IdentifierTakenError || err instanceof IdentifierReservedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  return null;
}
