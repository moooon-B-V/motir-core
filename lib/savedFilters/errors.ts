// Typed errors for the saved-filters domain (Story 6.2 · Subtask 6.2.1).
// Prisma-free (the lib/labels/errors pattern) so routes and client code can
// import them. The route layer translates the stable `code` to HTTP status
// via lib/savedFilters/errorResponse.ts:
//   SavedFilterNotFoundError        → 404 (missing, cross-tenant, OR a
//                                     private filter the actor may not see —
//                                     finding #44, no existence leak)
//   SavedFilterForbiddenError       → 403 (visible but the action is outside
//                                     the actor's matrix cell)
//   BuiltinSavedFilterImmutableError→ 403 (a write aimed at a `builtin:` id —
//                                     the mirror's "cannot be deleted or
//                                     edited" rule)
//   SavedFilterNameConflictError    → 409 (case-insensitive per-project
//                                     uniqueness — the story decision)
//   InvalidSavedFilterNameError     → 422 (blank / over-cap name or
//                                     description)
//   InvalidSavedFilterOwnerError    → 422 (change-owner target missing or
//                                     unable to browse the project)
// An invalid INCOMING AST keeps the lib/filters typed errors (→ 422); the
// project hide-gates reuse ProjectNotFoundError / ProjectAccessDeniedError.

/** Every saved-filter action the permission matrix gates — the closed
 * vocabulary `SavedFilterForbiddenError` reports and the matrix tests
 * enumerate (the totality-guard pattern). */
export type SavedFilterAction = 'create' | 'share' | 'update' | 'delete' | 'change-owner';

export class SavedFilterNotFoundError extends Error {
  readonly code = 'SAVED_FILTER_NOT_FOUND' as const;
  constructor(filterId: string) {
    super(`Saved filter ${filterId} was not found.`);
    this.name = 'SavedFilterNotFoundError';
  }
}

export class SavedFilterForbiddenError extends Error {
  readonly code = 'SAVED_FILTER_FORBIDDEN' as const;
  constructor(readonly action: SavedFilterAction) {
    super(`You do not have permission to ${action.replace('-', ' ')} this saved filter.`);
    this.name = 'SavedFilterForbiddenError';
  }
}

export class BuiltinSavedFilterImmutableError extends Error {
  readonly code = 'BUILTIN_SAVED_FILTER_IMMUTABLE' as const;
  constructor() {
    super('Built-in default filters cannot be edited, deleted, or starred.');
    this.name = 'BuiltinSavedFilterImmutableError';
  }
}

export class SavedFilterNameConflictError extends Error {
  readonly code = 'SAVED_FILTER_NAME_CONFLICT' as const;
  constructor(name: string) {
    super(`A saved filter named "${name}" already exists in this project.`);
    this.name = 'SavedFilterNameConflictError';
  }
}

export class InvalidSavedFilterNameError extends Error {
  readonly code = 'INVALID_SAVED_FILTER_NAME' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidSavedFilterNameError';
  }
}

export class InvalidSavedFilterOwnerError extends Error {
  readonly code = 'INVALID_SAVED_FILTER_OWNER' as const;
  constructor(userId: string) {
    super(`User ${userId} cannot own this filter — they cannot browse the project.`);
    this.name = 'InvalidSavedFilterOwnerError';
  }
}
