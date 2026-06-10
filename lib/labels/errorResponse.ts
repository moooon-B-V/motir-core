import { NextResponse } from 'next/server';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  InvalidLabelNameError,
  LabelLimitExceededError,
  LabelNameTooLongError,
} from '@/lib/labels/errors';

/**
 * Shared typed-error → HTTP mapping for the label routes (Story 5.4 ·
 * Subtask 5.4.2), the `projectMemberErrorResponse` pattern. Returns null for
 * errors the route should rethrow.
 *
 *   WorkItemNotFoundError / ProjectNotFoundError → 404 (hidden /
 *     cross-workspace ids are indistinguishable from never-existed ones —
 *     finding #44; the service has already converted browse-denials)
 *   ProjectAccessDeniedError                     → 403 (a browser without
 *     edit rights — the read-only viewer; only the 'edit' kind escapes the
 *     service)
 *   InvalidLabelNameError / LabelNameTooLongError /
 *   LabelLimitExceededError                      → 422 (folksonomy rules)
 */
export function mapLabelError(err: unknown): NextResponse | null {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (
    err instanceof InvalidLabelNameError ||
    err instanceof LabelNameTooLongError ||
    err instanceof LabelLimitExceededError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
