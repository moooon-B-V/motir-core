// Typed errors for the components domain (Story 5.4 · Subtask 5.4.3). Kept in
// their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status (see lib/components/errorResponse.ts):
//   ComponentNotFoundError          → 404 (unknown AND cross-workspace ids are
//                                          indistinguishable — finding #44)
//   InvalidComponentNameError       → 422 (blank, or over the length cap)
//   ComponentNameConflictError      → 409 (case-insensitive duplicate within
//                                          the project — the wart-fix rule)
//   InvalidDefaultAssigneeError     → 422 (not an assignable member of the
//                                          project — the 6.4.6 scoping)
//   InvalidMoveTargetError          → 422 (move-or-remove target missing,
//                                          self, or another project's)
//   CrossProjectComponentError      → 422 (assigning a component to an issue
//                                          in a different project)
//
// The hide-gates reuse the existing domains: a missing / cross-workspace /
// non-browsable issue is WorkItemNotFoundError (404); a browser without edit
// rights is ProjectAccessDeniedError('edit') (403); a non-admin managing the
// taxonomy is NotProjectAdminError (403, the 6.4 two-tier gate).

export class ComponentNotFoundError extends Error {
  readonly code = 'COMPONENT_NOT_FOUND' as const;
  constructor(componentId: string) {
    super(`Component ${componentId} not found.`);
    this.name = 'ComponentNotFoundError';
  }
}

export class InvalidComponentNameError extends Error {
  readonly code = 'INVALID_COMPONENT_NAME' as const;
  constructor(name: string, maxLength: number) {
    super(
      name.trim().length === 0
        ? 'A component name must not be empty.'
        : `Component "${name.slice(0, maxLength)}…" is too long (${maxLength} characters max).`,
    );
    this.name = 'InvalidComponentNameError';
  }
}

export class ComponentNameConflictError extends Error {
  readonly code = 'COMPONENT_NAME_CONFLICT' as const;
  constructor(name: string) {
    super(
      `A component named "${name}" already exists in this project (names are case-insensitive).`,
    );
    this.name = 'ComponentNameConflictError';
  }
}

export class InvalidDefaultAssigneeError extends Error {
  readonly code = 'INVALID_DEFAULT_ASSIGNEE' as const;
  constructor(userId: string) {
    super(
      `User ${userId} cannot be the default assignee — they are not an assignable member of this project.`,
    );
    this.name = 'InvalidDefaultAssigneeError';
  }
}

export class InvalidMoveTargetError extends Error {
  readonly code = 'INVALID_MOVE_TARGET' as const;
  constructor(reason: 'missing' | 'self' | 'cross_project') {
    super(
      reason === 'self'
        ? 'Work items cannot be moved to the component being deleted.'
        : reason === 'cross_project'
          ? 'Work items can only be moved to a component in the same project.'
          : 'The move-target component does not exist.',
    );
    this.name = 'InvalidMoveTargetError';
  }
}

export class CrossProjectComponentError extends Error {
  readonly code = 'CROSS_PROJECT_COMPONENT' as const;
  constructor(componentId: string) {
    super(`Component ${componentId} belongs to a different project than the work item.`);
    this.name = 'CrossProjectComponentError';
  }
}
