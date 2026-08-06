/**
 * The `/api/v1` operation table, as `@motir/cli` sees it.
 *
 * ⚠️ GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with `pnpm generate:cli-api` from the repository root (or
 * `pnpm --filter @motir/cli generate:api`, which delegates to it). CI
 * regenerates and fails on any diff, so a hand edit cannot survive a PR.
 *
 * Source: `emitOpenApiDocument()` in `lib/api/v1/openapi/emit.ts` — the same
 * value `/api/openapi/v1.json` serves. See `docs/decisions/cli-v1-client.md`.
 */

/** One declared operation: how to call it, and what it answers with. */
export interface V1OperationRow {
  /** The HTTP verb. */
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The path template, dynamic segments as `{name}`. */
  readonly path: string;
  /**
   * The token scope this operation requires.
   *
   * Read off the document's `x-motir-scope` extension, which the server
   * emits from `lib/mcp/scopes.ts`. This is where the CLI's 403 message gets
   * the scope name — never by parsing the server's English sentence.
   */
  readonly scope: string;
  /** The 2xx status the happy path returns. */
  readonly successStatus: number;
  /**
   * The component the success body IS, when it is a plain resource.
   * `undefined` for a paged response, whose body is an envelope composition
   * rather than one named component.
   */
  readonly responseComponent: string | undefined;
}

/**
 * The API MAJOR this client was generated against — the path version.
 *
 * A server serving a different major serves a different document at a
 * different URL (ADR Amendment 4 Q6), so a mismatch here is not a degraded
 * mode, it is a different API.
 */
export const API_MAJOR = 1;

/**
 * The contract version this client was generated against — `info.version`'s
 * `MAJOR.MINOR.PATCH`, NOT the deployment's release number.
 *
 * The version-skew gate compares a server's number against THIS. Within a
 * major, ADR §8 promises additive-only, so a server at or above this is
 * compatible by construction and only a server BELOW it can be missing
 * something this client was generated to expect.
 */
export const GENERATED_AGAINST = "1.3.0";

/** Every declared operation, keyed by `operationId`. */
export const V1_OPERATIONS = {
  "appendPlanTurn": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session/turns",
    scope: "work_items:write",
    successStatus: 200,
    responseComponent: "PlanSession",
  },
  "archiveWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/archive",
    scope: "work_items:archive",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "completeSession": {
    method: "POST",
    path: "/api/v1/sessions/complete",
    scope: "integration",
    successStatus: 200,
    responseComponent: "SessionCloseOut",
  },
  "completeSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/complete",
    scope: "sprints:write",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "createSprint": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/sprints",
    scope: "sprints:write",
    successStatus: 201,
    responseComponent: "Sprint",
  },
  "createWorkItem": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/work-items",
    scope: "work_items:write",
    successStatus: 201,
    responseComponent: "WorkItemDetail",
  },
  "createWorkItemComment": {
    method: "POST",
    path: "/api/v1/work-items/{key}/comments",
    scope: "work_items:write",
    successStatus: 201,
    responseComponent: undefined,
  },
  "createWorkItemLink": {
    method: "POST",
    path: "/api/v1/work-items/{key}/links",
    scope: "work_items:write",
    successStatus: 201,
    responseComponent: undefined,
  },
  "deleteWorkItemLink": {
    method: "DELETE",
    path: "/api/v1/work-items/{key}/links",
    scope: "work_items:write",
    successStatus: 204,
    responseComponent: undefined,
  },
  "getMe": {
    method: "GET",
    path: "/api/v1/me",
    scope: "read",
    successStatus: 200,
    responseComponent: "Me",
  },
  "getPlan": {
    method: "GET",
    path: "/api/v1/plans/{planId}",
    scope: "read",
    successStatus: 200,
    responseComponent: "Plan",
  },
  "getPlanStatus": {
    method: "GET",
    path: "/api/v1/plans/{planId}/status",
    scope: "read",
    successStatus: 200,
    responseComponent: "PlanOutcome",
  },
  "getProject": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}",
    scope: "read",
    successStatus: 200,
    responseComponent: "Project",
  },
  "getProjectBacklog": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/backlog",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getProjectReadySet": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/ready",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getSprint": {
    method: "GET",
    path: "/api/v1/sprints/{sprintId}",
    scope: "read",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "getWorkItem": {
    method: "GET",
    path: "/api/v1/work-items/{key}",
    scope: "read",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "getWorkItemActivity": {
    method: "GET",
    path: "/api/v1/work-items/{key}/activity",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getWorkItemDispatchPrompt": {
    method: "GET",
    path: "/api/v1/work-items/{key}/dispatch-prompt",
    scope: "read",
    successStatus: 200,
    responseComponent: "DispatchPrompt",
  },
  "listProjects": {
    method: "GET",
    path: "/api/v1/projects",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectSprints": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/sprints",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectWorkItems": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/work-items",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listSprintWorkItems": {
    method: "GET",
    path: "/api/v1/sprints/{sprintId}/work-items",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemComments": {
    method: "GET",
    path: "/api/v1/work-items/{key}/comments",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemLinks": {
    method: "GET",
    path: "/api/v1/work-items/{key}/links",
    scope: "read",
    successStatus: 200,
    responseComponent: "WorkItemLinkGroups",
  },
  "listWorkItemTransitions": {
    method: "GET",
    path: "/api/v1/work-items/{key}/transitions",
    scope: "read",
    successStatus: 200,
    responseComponent: "TransitionList",
  },
  "listWorkspaces": {
    method: "GET",
    path: "/api/v1/workspaces",
    scope: "read",
    successStatus: 200,
    responseComponent: undefined,
  },
  "moveWorkItemsToBacklog": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/backlog/work-items",
    scope: "sprints:write",
    successStatus: 200,
    responseComponent: "MembershipMoveResult",
  },
  "moveWorkItemsToSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/work-items",
    scope: "sprints:write",
    successStatus: 200,
    responseComponent: "MembershipMoveResult",
  },
  "openPlanSession": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session",
    scope: "read",
    successStatus: 200,
    responseComponent: "PlanSession",
  },
  "recordWorkItemIntegration": {
    method: "POST",
    path: "/api/v1/work-items/{key}/integration",
    scope: "integration",
    successStatus: 200,
    responseComponent: "IntegrationResult",
  },
  "restoreWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/restore",
    scope: "work_items:archive",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "startSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/start",
    scope: "sprints:write",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "submitPlanSession": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session/submissions",
    scope: "work_items:write",
    successStatus: 202,
    responseComponent: "PlanJobHandle",
  },
  "submitWorkItemExpansion": {
    method: "POST",
    path: "/api/v1/work-items/{key}/expansions",
    scope: "work_items:write",
    successStatus: 202,
    responseComponent: "PlanJobHandle",
  },
  "transitionWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/transitions",
    scope: "work_items:write",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "updateSprint": {
    method: "PATCH",
    path: "/api/v1/sprints/{sprintId}",
    scope: "sprints:write",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "updateWorkItem": {
    method: "PATCH",
    path: "/api/v1/work-items/{key}",
    scope: "work_items:write",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
} as const satisfies Record<string, V1OperationRow>;

/** The `operationId`s, as a union. */
export type V1OperationId = keyof typeof V1_OPERATIONS;
