// Typed errors for the workflow-management domain (Story 2.2 · Subtask 2.2.5).
// Kept in their own file so callers — Server Actions, the service layer — can
// import them without pulling in the Prisma client. Each carries a stable
// string `code` the action/route layer maps to an HTTP status, matching the
// `readonly code` convention the projects/workspaces domains established.

/** The caller isn't a project admin (v1: the workspace owner). → 403. */
export class NotProjectAdminError extends Error {
  readonly code = 'NOT_PROJECT_ADMIN' as const;
  constructor(message = 'You must be a project admin to manage its workflow.') {
    super(message);
    this.name = 'NotProjectAdminError';
  }
}

/** A status with this `key` already exists in the project. → 422. */
export class StatusKeyConflictError extends Error {
  readonly code = 'STATUS_KEY_CONFLICT' as const;
  readonly key: string;
  constructor(key: string) {
    super(`A status with key "${key}" already exists in this project.`);
    this.name = 'StatusKeyConflictError';
    this.key = key;
  }
}

/** No workflow status matched the id (in the active workspace). → 404. */
export class WorkflowStatusNotFoundError extends Error {
  readonly code = 'WORKFLOW_STATUS_NOT_FOUND' as const;
  constructor(statusId: string) {
    super(`Workflow status ${statusId} not found.`);
    this.name = 'WorkflowStatusNotFoundError';
  }
}

/** No workflow transition matched the id (in the active workspace). → 404. */
export class WorkflowTransitionNotFoundError extends Error {
  readonly code = 'WORKFLOW_TRANSITION_NOT_FOUND' as const;
  constructor(transitionId: string) {
    super(`Workflow transition ${transitionId} not found.`);
    this.name = 'WorkflowTransitionNotFoundError';
  }
}

/**
 * Refuse to delete a status still referenced by a work item's status, WHEN no
 * reassignment target was supplied. → 422. The UI catches this (it carries the
 * `count`) and re-prompts with the delete-with-reassign modal (Subtask 2.3.1).
 */
export class StatusInUseError extends Error {
  readonly code = 'STATUS_IN_USE' as const;
  readonly statusKey: string;
  readonly count: number;
  constructor(statusKey: string, count: number) {
    super(`Status "${statusKey}" is still used by ${count} work item(s) and can't be deleted.`);
    this.name = 'StatusInUseError';
    this.statusKey = statusKey;
    this.count = count;
  }
}

/**
 * The delete-with-reassign target (Subtask 2.3.1) is invalid: it doesn't exist,
 * belongs to another project, or is the status being deleted itself. → 422.
 */
export class InvalidReassignTargetError extends Error {
  readonly code = 'INVALID_REASSIGN_TARGET' as const;
  constructor(message = 'Pick a different status in this project to move the items to.') {
    super(message);
    this.name = 'InvalidReassignTargetError';
  }
}

/**
 * A default status is protected (Subtask 2.2.10): it can be recolored but not
 * renamed, recategorized, reordered, or deleted (finding #49). → 422.
 */
export class DefaultStatusProtectedError extends Error {
  readonly code = 'DEFAULT_STATUS_PROTECTED' as const;
  constructor(statusKey: string) {
    super(`"${statusKey}" is a default status — only its color can be changed.`);
    this.name = 'DefaultStatusProtectedError';
  }
}

/** Refuse to delete the project's initial status. → 422. */
export class CannotDeleteInitialStatusError extends Error {
  readonly code = 'CANNOT_DELETE_INITIAL_STATUS' as const;
  readonly statusKey: string;
  constructor(statusKey: string) {
    super(`Status "${statusKey}" is the initial status and can't be deleted.`);
    this.name = 'CannotDeleteInitialStatusError';
    this.statusKey = statusKey;
  }
}

/**
 * Refuse to delete the project's LAST terminal (`category = done`) status — a
 * project must always have at least one way to reach "done" (the readiness
 * predicate, finding #21, depends on a non-empty terminal set). → 422.
 */
export class CannotDeleteLastTerminalStatusError extends Error {
  readonly code = 'CANNOT_DELETE_LAST_TERMINAL_STATUS' as const;
  readonly statusKey: string;
  constructor(statusKey: string) {
    super(`Status "${statusKey}" is the only terminal status — a project needs at least one.`);
    this.name = 'CannotDeleteLastTerminalStatusError';
    this.statusKey = statusKey;
  }
}
