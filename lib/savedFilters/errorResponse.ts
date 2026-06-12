import { NextResponse } from 'next/server';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { FilterValidationError } from '@/lib/filters/errors';
import {
  BuiltinSavedFilterImmutableError,
  InvalidSavedFilterNameError,
  InvalidSavedFilterOwnerError,
  InvalidSubscriptionScheduleError,
  SavedFilterForbiddenError,
  SavedFilterNameConflictError,
  SavedFilterNotFoundError,
} from '@/lib/savedFilters/errors';

/**
 * Shared typed-error → HTTP mapping for the saved-filter routes (Story 6.2 ·
 * Subtask 6.2.1), the `mapLabelError` pattern. Returns null for errors the
 * route should rethrow.
 *
 *   ProjectNotFoundError / SavedFilterNotFoundError → 404 (missing,
 *     cross-tenant, or merely invisible — finding #44, indistinguishable)
 *   SavedFilterForbiddenError / ProjectAccessDeniedError /
 *   BuiltinSavedFilterImmutableError                → 403 (visible but the
 *     action sits outside the actor's matrix cell; built-ins reject every
 *     write — the mirror's "cannot be deleted or edited")
 *   SavedFilterNameConflictError                    → 409 (case-insensitive
 *     per-project uniqueness)
 *   InvalidSavedFilterNameError / InvalidSavedFilterOwnerError /
 *   FilterValidationError                           → 422 (an invalid
 *     INCOMING name / owner / criteria AST is a rejection — only a STORED
 *     envelope degrades instead, on the resolve read)
 */
export function mapSavedFilterError(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError || err instanceof SavedFilterNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (
    err instanceof SavedFilterForbiddenError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof BuiltinSavedFilterImmutableError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof SavedFilterNameConflictError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (
    err instanceof InvalidSavedFilterNameError ||
    err instanceof InvalidSavedFilterOwnerError ||
    err instanceof InvalidSubscriptionScheduleError ||
    err instanceof FilterValidationError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
