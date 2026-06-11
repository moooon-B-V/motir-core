import { NextResponse } from 'next/server';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  ComponentNameConflictError,
  ComponentNotFoundError,
  CrossProjectComponentError,
  InvalidComponentNameError,
  InvalidDefaultAssigneeError,
  InvalidMoveTargetError,
} from '@/lib/components/errors';

/**
 * Shared typed-error → HTTP mapping for the component routes (Story 5.4 ·
 * Subtask 5.4.3), the `mapLabelError` pattern. Returns null for errors the
 * route should rethrow.
 *
 *   WorkItemNotFoundError / ProjectNotFoundError /
 *   ComponentNotFoundError                       → 404 (hidden /
 *     cross-workspace ids are indistinguishable from never-existed ones —
 *     finding #44; the service has already converted browse-denials)
 *   NotProjectAdminError                         → 403 (the 6.4 two-tier
 *     admin gate on the taxonomy mutations)
 *   ProjectAccessDeniedError                     → 403 (a browser without
 *     edit rights — the read-only viewer; only the 'edit' kind escapes the
 *     service)
 *   ComponentNameConflictError                   → 409 (the case-insensitive
 *     unique — the FieldKeyConflictError precedent)
 *   InvalidComponentNameError / InvalidDefaultAssigneeError /
 *   InvalidMoveTargetError / CrossProjectComponentError → 422
 */
export function mapComponentError(err: unknown): NextResponse | null {
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof ComponentNotFoundError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof NotProjectAdminError || err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof ComponentNameConflictError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (
    err instanceof InvalidComponentNameError ||
    err instanceof InvalidDefaultAssigneeError ||
    err instanceof InvalidMoveTargetError ||
    err instanceof CrossProjectComponentError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
