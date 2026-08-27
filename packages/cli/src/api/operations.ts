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
   * The PERMISSION this operation requires.
   *
   * Read off the document's `x-motir-permission` extension, which the server
   * emits from `lib/mcp/toolPermissions.ts` + the v1 declarations. This is where
   * the CLI's 403 message gets the permission name — never by parsing the
   * server's English sentence.
   */
  readonly permission: string;
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
export const GENERATED_AGAINST = "1.21.0";

/** Every declared operation, keyed by `operationId`. */
export const V1_OPERATIONS = {
  "appendPlanTurn": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session/turns",
    permission: "ai:plan",
    successStatus: 200,
    responseComponent: "PlanSession",
  },
  "approveWorkItemPlan": {
    method: "POST",
    path: "/api/v1/work-items/{key}/plan-approval",
    permission: "ai:decide_plan",
    successStatus: 200,
    responseComponent: "Plan",
  },
  "archiveWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/archive",
    permission: "work_item:archive",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "claimScope": {
    method: "POST",
    path: "/api/v1/scope-claims",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "ScopeClaim",
  },
  "claimWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/claim",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemClaim",
  },
  "completeSession": {
    method: "POST",
    path: "/api/v1/sessions/complete",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "SessionCloseOut",
  },
  "completeSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/complete",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "countProjectWorkItems": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/work-items/count",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "WorkItemCount",
  },
  "createSprint": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/sprints",
    permission: "sprint:manage",
    successStatus: 201,
    responseComponent: "Sprint",
  },
  "createWorkItem": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/work-items",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: "WorkItemDetail",
  },
  "createWorkItemComment": {
    method: "POST",
    path: "/api/v1/work-items/{key}/comments",
    permission: "comment:add",
    successStatus: 201,
    responseComponent: undefined,
  },
  "createWorkItemLink": {
    method: "POST",
    path: "/api/v1/work-items/{key}/links",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: undefined,
  },
  "deleteWorkItemLink": {
    method: "DELETE",
    path: "/api/v1/work-items/{key}/links",
    permission: "work_item:edit",
    successStatus: 204,
    responseComponent: undefined,
  },
  "getMe": {
    method: "GET",
    path: "/api/v1/me",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Me",
  },
  "getPlan": {
    method: "GET",
    path: "/api/v1/plans/{planId}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Plan",
  },
  "getPlanStatus": {
    method: "GET",
    path: "/api/v1/plans/{planId}/status",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "PlanOutcome",
  },
  "getProject": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Project",
  },
  "getProjectBacklog": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/backlog",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getProjectReadySet": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/ready",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getSprint": {
    method: "GET",
    path: "/api/v1/sprints/{sprintId}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "getWorkItem": {
    method: "GET",
    path: "/api/v1/work-items/{key}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "getWorkItemActivity": {
    method: "GET",
    path: "/api/v1/work-items/{key}/activity",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getWorkItemDispatchPrompt": {
    method: "GET",
    path: "/api/v1/work-items/{key}/dispatch-prompt",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "DispatchPrompt",
  },
  "listProjectRepositories": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/repositories",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjects": {
    method: "GET",
    path: "/api/v1/projects",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectSprints": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/sprints",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectWorkItems": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/work-items",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listSprintWorkItems": {
    method: "GET",
    path: "/api/v1/sprints/{sprintId}/work-items",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemComments": {
    method: "GET",
    path: "/api/v1/work-items/{key}/comments",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemLinks": {
    method: "GET",
    path: "/api/v1/work-items/{key}/links",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "WorkItemLinkGroups",
  },
  "listWorkItemTransitions": {
    method: "GET",
    path: "/api/v1/work-items/{key}/transitions",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "TransitionList",
  },
  "listWorkspaces": {
    method: "GET",
    path: "/api/v1/workspaces",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "moveWorkItemsToBacklog": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/backlog/work-items",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "MembershipMoveResult",
  },
  "moveWorkItemsToSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/work-items",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "MembershipMoveResult",
  },
  "openPlanSession": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session",
    permission: "ai:plan",
    successStatus: 200,
    responseComponent: "PlanSession",
  },
  "recordWorkItemIntegration": {
    method: "POST",
    path: "/api/v1/work-items/{key}/integration",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "IntegrationResult",
  },
  "reportWorkItemImplementation": {
    method: "POST",
    path: "/api/v1/work-items/{key}/implementation",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: undefined,
  },
  "restoreWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/restore",
    permission: "work_item:archive",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "startSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/start",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "submitPlanSession": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session/submissions",
    permission: "ai:plan",
    successStatus: 202,
    responseComponent: "PlanJobHandle",
  },
  "submitWorkItemExpansion": {
    method: "POST",
    path: "/api/v1/work-items/{key}/expansions",
    permission: "ai:plan",
    successStatus: 202,
    responseComponent: "PlanJobHandle",
  },
  "transitionWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/transitions",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "updateSprint": {
    method: "PATCH",
    path: "/api/v1/sprints/{sprintId}",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "updateWorkItem": {
    method: "PATCH",
    path: "/api/v1/work-items/{key}",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "uploadWorkItemAttachment": {
    method: "POST",
    path: "/api/v1/work-items/{key}/attachments",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: "Attachment",
  },
} as const satisfies Record<string, V1OperationRow>;

/** The `operationId`s, as a union. */
export type V1OperationId = keyof typeof V1_OPERATIONS;
