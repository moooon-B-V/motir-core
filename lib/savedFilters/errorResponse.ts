import { NextResponse } from 'next/server';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
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
 *   PermissionDeniedError                           → 403 + the missing key
 *     (MOTIR-2352 — the project-level `saved_filter:manage` gate, distinct from
 *     the per-ROW matrix cell above)
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
  // MOTIR-2352 — the shared gate's 403, raised when the actor may browse the
  // project but does not hold `saved_filter:manage`. It carries the key it asked
  // for, which the two 403s above do not, so it keeps its own arm rather than
  // being folded into theirs. A NON-browser never reaches here: `assertPermission`
  // raises `ProjectNotFoundError` first, which the 404 arm above already maps.
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
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
