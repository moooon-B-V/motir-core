// Typed errors for the estimation domain (Story 4.3 · Subtask 4.3.3). Kept in
// their own file so the service layer and the route handlers can import them
// without pulling in the Prisma client. Each carries a stable string `code` the
// route layer maps to an HTTP status, matching the `readonly code` convention
// the sprints / boards / workflows / projects domains established.
//
// Status-code map (the route layer owns the translation):
//   InvalidEstimateError            → 422
//   InvalidScaleConfigError         → 422
//   EstimationConfigForbiddenError  → 403
//
// A missing / cross-workspace issue reuses `WorkItemNotFoundError`
// (lib/workItems/errors.ts → 404); a missing / cross-workspace project reuses
// `ProjectNotFoundError` (lib/projects/errors.ts → 404); a missing sprint reuses
// `SprintNotFoundError` (lib/sprints/errors.ts → 404) — the same not-found reuse
// `backlogService` / `boardsService` make, rather than inventing parallels.

/**
 * A story-point estimate value was malformed — not a finite number, negative,
 * out of the `Decimal(6, 2)` range, or carrying more than two decimal places.
 * The entity is well-formed but the value semantics are wrong, so the route
 * maps it to 422 (the same family as the sprint window error). → 422.
 */
export class InvalidEstimateError extends Error {
  readonly code = 'INVALID_ESTIMATE' as const;
  constructor(reason = 'A story-point estimate must be a non-negative number within range.') {
    super(reason);
    this.name = 'InvalidEstimateError';
  }
}

/**
 * The project estimation config patch is invalid — an unknown statistic / scale
 * enum value, or a `customScaleValues` deck that is empty / non-numeric /
 * negative when the effective `pointScale` is `custom`. → 422.
 */
export class InvalidScaleConfigError extends Error {
  readonly code = 'INVALID_SCALE_CONFIG' as const;
  constructor(reason = 'The estimation configuration is invalid.') {
    super(reason);
    this.name = 'InvalidScaleConfigError';
  }
}

/**
 * The actor is not authorized to change the project's estimation config. v1
 * routes "estimation admin" to the workspace OWNER (finding #36), EXACTLY the
 * same project-admin gate the Workflow + Board settings editors use — managing
 * estimation is project-planning configuration, the same tier, and Jira gates
 * board Estimation settings to admins (decision-ladder rung 1). Full per-project
 * RBAC is Story 6.4; the gate SHAPE is durable, only the role-set widens. → 403.
 */
export class EstimationConfigForbiddenError extends Error {
  readonly code = 'ESTIMATION_CONFIG_FORBIDDEN' as const;
  constructor() {
    super('You do not have permission to change estimation settings for this project.');
    this.name = 'EstimationConfigForbiddenError';
  }
}
