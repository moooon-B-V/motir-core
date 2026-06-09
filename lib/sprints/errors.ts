import type { SprintState } from '@prisma/client';

// Typed errors for the sprint domain (Story 4.1 · Subtask 4.1.3). Kept in their
// own file so callers — the service layer and the CRUD route handlers — can
// import them without pulling in the Prisma client. Each carries a stable string
// `code` the route layer maps to an HTTP status, matching the `readonly code`
// convention the boards / workflows / projects domains established.
//
// Status-code map (the route layer owns the translation):
//   SprintNotFoundError                → 404
//   NotSprintAdminError                → 403
//   InvalidSprintNameError             → 400
//   SprintWindowInvalidError           → 422
//   InvalidSprintTransitionError       → 409
//   CannotModifyCompletedSprintError   → 409
//   CannotDeleteActiveSprintError      → 409
//   CrossProjectSprintAssignmentError  → 422 (Subtask 4.1.4)
//
// A foreign / unknown projectId (the create path) reuses `ProjectNotFoundError`
// from `lib/projects/errors.ts` (already a 404) rather than inventing a parallel
// project-not-found error — the same reuse `boardsService` makes.

/** No sprint matched the id in the active workspace. → 404. */
export class SprintNotFoundError extends Error {
  readonly code = 'SPRINT_NOT_FOUND' as const;
  readonly sprintId: string;
  constructor(sprintId: string) {
    super(`Sprint ${sprintId} not found.`);
    this.name = 'SprintNotFoundError';
    this.sprintId = sprintId;
  }
}

/**
 * The actor is not authorized to manage sprints for the project. v1 routes
 * "sprint admin" to the workspace OWNER, EXACTLY mirroring `boardsService`'s
 * `NotBoardAdminError` / `assertBoardConfigAdmin` (finding #36): managing
 * sprints is project-planning configuration, the same tier as the board / WIP /
 * workflow editors, and Jira gates sprint management to admins (decision-ladder
 * rung 1). Full per-project RBAC is Story 6.4 — the gate SHAPE is already
 * durable; only the allowed role-set widens (TODO(6.4)). → 403.
 */
export class NotSprintAdminError extends Error {
  readonly code = 'NOT_SPRINT_ADMIN' as const;
  constructor() {
    super('You do not have permission to manage sprints for this project.');
    this.name = 'NotSprintAdminError';
  }
}

/** A blank / whitespace-only sprint name was supplied. → 400. */
export class InvalidSprintNameError extends Error {
  readonly code = 'INVALID_SPRINT_NAME' as const;
  constructor() {
    super('Sprint name must not be empty.');
    this.name = 'InvalidSprintNameError';
  }
}

/**
 * The sprint window is invalid — a date string did not parse, or `endDate` is
 * before `startDate`. Distinct from a name error so the route maps it to 422
 * (the entity is well-formed but the date semantics are wrong). → 422.
 */
export class SprintWindowInvalidError extends Error {
  readonly code = 'SPRINT_WINDOW_INVALID' as const;
  constructor(reason = 'The sprint end date must not be before its start date.') {
    super(reason);
    this.name = 'SprintWindowInvalidError';
  }
}

/**
 * A sprint state transition that the lifecycle does not allow. The machine is
 * one-way: `planned → active → complete`. Every skip (`planned → complete`),
 * reopen (`complete → active`, `active → planned`) and self-transition is
 * rejected here. Thrown by the pure `assertSprintTransition` guard so Story
 * 4.4's start/complete flows + the one-active guard share one rule. → 409.
 */
export class InvalidSprintTransitionError extends Error {
  readonly code = 'INVALID_SPRINT_TRANSITION' as const;
  readonly from: SprintState;
  readonly to: SprintState;
  constructor(from: SprintState, to: SprintState) {
    super(`Illegal sprint transition: "${from}" → "${to}".`);
    this.name = 'InvalidSprintTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** A `complete` sprint cannot be edited (rename / goal / window). → 409. */
export class CannotModifyCompletedSprintError extends Error {
  readonly code = 'CANNOT_MODIFY_COMPLETED_SPRINT' as const;
  readonly sprintId: string;
  constructor(sprintId: string) {
    super(`Sprint ${sprintId} is complete and can no longer be edited.`);
    this.name = 'CannotModifyCompletedSprintError';
    this.sprintId = sprintId;
  }
}

/**
 * The `active` sprint cannot be deleted — ending a running sprint goes through
 * Story 4.4's *complete* flow (carry-over of unfinished issues), not a hard
 * delete. A `planned` or `complete` sprint deletes freely. → 409.
 */
export class CannotDeleteActiveSprintError extends Error {
  readonly code = 'CANNOT_DELETE_ACTIVE_SPRINT' as const;
  readonly sprintId: string;
  constructor(sprintId: string) {
    super(`Sprint ${sprintId} is active and cannot be deleted; complete it instead.`);
    this.name = 'CannotDeleteActiveSprintError';
    this.sprintId = sprintId;
  }
}

/**
 * An issue was assigned to a sprint that belongs to a DIFFERENT project
 * (Subtask 4.1.4). A sprint is project-scoped (`sprint.projectId`; see the
 * story-4.1 module header), so the backlog/sprint association only ever moves
 * an issue between sprints WITHIN its own project. The same-project guard in
 * `backlogService.assignToSprint` throws this BEFORE the write — the structural
 * analogue of `CrossProjectParentError` (also a 422: the entities are
 * well-formed, but pairing them across projects is semantically invalid). → 422.
 */
export class CrossProjectSprintAssignmentError extends Error {
  readonly code = 'CROSS_PROJECT_SPRINT_ASSIGNMENT' as const;
  readonly itemId: string;
  readonly sprintId: string;
  constructor(itemId: string, sprintId: string) {
    super(`Issue ${itemId} cannot be assigned to sprint ${sprintId} in another project.`);
    this.name = 'CrossProjectSprintAssignmentError';
    this.itemId = itemId;
    this.sprintId = sprintId;
  }
}
