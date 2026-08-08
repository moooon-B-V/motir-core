import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import { FILTER_PARAM } from '@/lib/filters/ast';
import { meSchema, workspaceSummarySchema } from '@/lib/api/v1/identity/schema';
import { v1CursorSchema } from '@/lib/api/v1/openapi/envelopes';
import {
  defineOperation,
  type V1Operation,
  type V1Parameter,
} from '@/lib/api/v1/openapi/operation';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import { projectSchema } from '@/lib/api/v1/projects/schema';
import { readyItemSchema, UNASSIGNED } from '@/lib/api/v1/ready/schema';
import {
  membershipMoveBodySchema,
  membershipMoveResultSchema,
} from '@/lib/api/v1/sprints/membership';
import {
  completeSprintBodySchema,
  createSprintBodySchema,
  sprintSchema,
  startSprintBodySchema,
  updateSprintBodySchema,
} from '@/lib/api/v1/sprints/schema';
import { workItemRefSchema } from '@/lib/api/v1/workItems/schema';

// The IDENTITY + PLANNING operations (Story 11.4 · Subtask 11.4.5 — MOTIR-2186).
//
// Story 11.4.4 proved the registry and the emitter on the work-item resource.
// This module finishes the surface: `/me`, workspaces, projects, sprints, the
// backlog, the sprint-membership moves and the ready set — so the emitted
// document describes the whole API rather than a sample of it.
//
// Every declaration below was read off the ROUTE and its schema module, not off
// its neighbour: the scope from `withV1Route`, the query parameters from the
// parser the handler actually calls, and the envelope from whether the handler
// returns `presentRankedPage` (which carries `totalCount`) or a plain
// `paginate*` envelope. `tests/api/v1/openapi-operations-coverage.test.ts` walks
// the tree and FAILS on a route method with no declaration, so this file cannot
// silently fall behind a route added later.
//
// ── WHICH ENVELOPE, and why it is read rather than inferred ─────────────────
// ADR Amendment 3 Q2 decided this per endpoint, and the split is not the one a
// reader would guess: the BACKLOG and a SPRINT'S MEMBERS return the ranked
// envelope because both underlying reads already compute `totalCount` as a
// bounded aggregate they have paid for. Projects, sprints, workspaces and the
// READY set return the plain envelope and omit the field entirely — absent,
// never null and never zero — because they have no equivalent cheap count.

/** The shared cursor + limit query parameters, on every collection. */
function pageParameters(): V1Parameter[] {
  return [
    {
      name: 'cursor',
      in: 'query',
      required: false,
      description:
        'An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset.',
      schema: v1CursorSchema,
    },
    {
      name: 'limit',
      in: 'query',
      required: false,
      description: `Rows per page. Defaults to ${DEFAULT_PAGE_LIMIT}; a larger value is CLAMPED to ${MAX_PAGE_LIMIT} rather than rejected.`,
      schema: z.number().int().positive(),
    },
  ];
}

/** The `?filter=` parameter the two ranked collections and the item list accept. */
function filterParameter(): V1Parameter {
  return {
    name: FILTER_PARAM,
    in: 'query',
    required: false,
    description:
      'A serialised filter expression, in the same grammar the product’s own list views use — never an ad-hoc `?status=&assignee=` axis. An unknown field, operator or value is a 422 naming which.',
    schema: z.string().min(1),
  };
}

function pathParameter(name: string, description: string, schema: ZodType): V1Parameter {
  return { name, in: 'path', required: true, description, schema };
}

const projectKeyParameter = pathParameter(
  'projectKey',
  'The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`.',
  z.string().min(1),
);

const sprintIdParameter = pathParameter(
  'sprintId',
  'The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire.',
  z.string().min(1),
);

/** Every identity + planning operation, in the order the reference lists them. */
export const PLANNING_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/me',
    operationId: 'getMe',
    summary: 'Who this token is',
    description:
      'The token owner, the workspace the token is bound to, and the scopes it was granted. Call this first: the scope list is how a client discovers what its own credential may do without probing endpoints and collecting 403s.',
    scope: 'read',
    parameters: [],
    response: {
      status: 200,
      body: { kind: 'object', schema: meSchema },
      description: 'The token’s identity and granted scopes.',
    },
    // Nothing beyond the wrapper's own failures: there is nothing to look up
    // and nothing to parse.
    errorStatuses: [],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/workspaces',
    operationId: 'listWorkspaces',
    summary: 'List the workspaces this token’s owner belongs to',
    description:
      'A discovery read, and the ONE place v1 answers at the account level rather than the bound workspace: it returns the workspaces the token OWNER is a member of, so a client holding a fresh token can learn which workspace ids exist for it. Every resource endpoint stays scoped to the bound workspace.',
    scope: 'read',
    parameters: pageParameters(),
    response: {
      status: 200,
      body: { kind: 'page', item: workspaceSummarySchema },
      description: 'A page of workspaces.',
    },
    errorStatuses: [422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects',
    operationId: 'listProjects',
    summary: 'List the projects in this token’s workspace',
    description:
      'Every project the token owner may browse in the bound workspace, ordered by key ascending — a total order the page addressing owns, so a cursor can never skip or duplicate a row.',
    scope: 'read',
    parameters: pageParameters(),
    response: {
      status: 200,
      body: { kind: 'page', item: projectSchema },
      description: 'A page of projects.',
    },
    errorStatuses: [422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}',
    operationId: 'getProject',
    summary: 'Read a project',
    description:
      'One project by key. A project the caller may not browse answers 404, not 403 — a 403 would confirm the project exists and let a caller enumerate which keys are real.',
    scope: 'read',
    parameters: [projectKeyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: projectSchema },
      description: 'The project.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/sprints',
    operationId: 'listProjectSprints',
    summary: 'List a project’s sprints',
    description: 'The project’s sprints in sequence order, cursor-paged.',
    scope: 'read',
    parameters: [projectKeyParameter, ...pageParameters()],
    response: {
      status: 200,
      body: { kind: 'page', item: sprintSchema },
      description: 'A page of sprints.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/sprints',
    operationId: 'createSprint',
    summary: 'Create a planned sprint',
    description:
      'Create a sprint in the `planned` state. ⚠️ TWO gates apply: the token needs `sprints:write`, AND its OWNER must be a sprint admin — a scope narrows a role and never widens it, so an ordinary member’s token is refused with the distinct `NOT_SPRINT_ADMIN` code rather than `INSUFFICIENT_SCOPE`. The `Location` header names the created sprint.',
    scope: 'sprints:write',
    parameters: [projectKeyParameter],
    requestBody: { schema: createSprintBodySchema, description: 'The sprint to create.' },
    response: {
      status: 201,
      body: { kind: 'object', schema: sprintSchema },
      description: 'The created sprint.',
    },
    errorStatuses: [403, 404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/backlog',
    operationId: 'getProjectBacklog',
    summary: 'Read a project’s backlog',
    description:
      'The to-be-planned pile, in backlog-rank order. ⚠️ Done-category items are EXCLUDED — a finished unsprinted item does not belong in the backlog. (A sprint’s members are deliberately NOT filtered that way; see `listSprintWorkItems`.) Reports a total, because the read behind it already computes one.',
    scope: 'read',
    parameters: [projectKeyParameter, ...pageParameters(), filterParameter()],
    response: {
      status: 200,
      body: { kind: 'rankedPage', item: workItemRefSchema },
      description: 'A page of backlog items, with the total behind it.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/backlog/work-items',
    operationId: 'moveWorkItemsToBacklog',
    summary: 'Move work items out of their sprint and back to the backlog',
    description:
      'An atomic batch move. An EMPTY array is a deliberate 200 no-op, not an error: a script that computed an empty batch has nothing to do rather than a mistake to fix. An over-cap batch is refused WHOLE, never partially applied.',
    scope: 'sprints:write',
    parameters: [projectKeyParameter],
    requestBody: { schema: membershipMoveBodySchema, description: 'The work items to move.' },
    response: {
      status: 200,
      body: { kind: 'object', schema: membershipMoveResultSchema },
      description: 'The keys that moved, in request order.',
    },
    errorStatuses: [403, 404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/ready',
    operationId: 'getProjectReadySet',
    summary: 'Read a project’s READY set',
    description:
      'The work items whose every `blocked_by` dependency is done — what an agent loop claims from. Each row carries its dependency edges. Reports no total: unlike the backlog, this read has no cheap bounded count.',
    scope: 'read',
    parameters: [
      projectKeyParameter,
      ...pageParameters(),
      {
        name: 'kind',
        in: 'query',
        required: false,
        description:
          'Narrow to one or more work-item kinds, as `?kind=epic&kind=story`. An unknown kind is a 422.',
        // An ARRAY, matching `parseReadyFilters`' `params.getAll('kind')`. It
        // was declared as a scalar until MOTIR-2317 while the description said
        // "Repeatable" — a document that under-described its own route, which
        // went unnoticed until a client was GENERATED from it and inherited a
        // type that cannot express two kinds.
        schema: z.array(z.string().min(1)),
        explode: true,
      },
      {
        name: 'priority',
        in: 'query',
        required: false,
        description:
          'Narrow to one or more priorities, as `?priority=high&priority=urgent`. An unknown priority is a 422.',
        schema: z.array(z.string().min(1)),
        explode: true,
      },
      {
        name: 'assigneeId',
        in: 'query',
        required: false,
        description: `TRI-STATE, and all three are reachable: OMIT for any assignee, the literal \`${UNASSIGNED}\` for the unassigned bucket, or a user id for that user's items. An empty value is treated as omitted.`,
        schema: z.string().min(1),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'page', item: readyItemSchema },
      description: 'A page of ready work items with their dependency edges.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/sprints/{sprintId}',
    operationId: 'getSprint',
    summary: 'Read a sprint',
    description:
      'One sprint by id. A sprint in another workspace and one that never existed are the same 404 — the existence-oracle rule.',
    scope: 'read',
    parameters: [sprintIdParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: sprintSchema },
      description: 'The sprint.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'PATCH',
    path: '/api/v1/sprints/{sprintId}',
    operationId: 'updateSprint',
    summary: 'Update a sprint',
    description:
      'Patch a sprint’s name, goal or window. A COMPLETED sprint is frozen: the body is fine, the state is not, so the refusal is a 409 rather than a 422.',
    scope: 'sprints:write',
    parameters: [sprintIdParameter],
    requestBody: { schema: updateSprintBodySchema, description: 'The fields to change.' },
    response: {
      status: 200,
      body: { kind: 'object', schema: sprintSchema },
      description: 'The updated sprint.',
    },
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/sprints/{sprintId}/start',
    operationId: 'startSprint',
    summary: 'Start a sprint',
    description:
      'Move a planned sprint to active. ⚠️ Losing the race to activate is a 409, not a 422: the request was valid when it was sent and another one committed first, so the right instruction is re-read-and-retry rather than fix-your-body. Starting a sprint that is not planned is a 422 — a state the caller can see from a read.',
    scope: 'sprints:write',
    parameters: [sprintIdParameter],
    requestBody: {
      schema: startSprintBodySchema,
      description: 'The sprint window, if it is being set here.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: sprintSchema },
      description: 'The active sprint.',
    },
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/sprints/{sprintId}/complete',
    operationId: 'completeSprint',
    summary: 'Complete a sprint',
    description:
      'Close an active sprint, optionally carrying its unfinished items over to a named target. Completing a sprint that is not active is a 422.',
    scope: 'sprints:write',
    parameters: [sprintIdParameter],
    requestBody: {
      schema: completeSprintBodySchema,
      description: 'Where unfinished items go, if anywhere.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: sprintSchema },
      description: 'The completed sprint.',
    },
    errorStatuses: [403, 404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/sprints/{sprintId}/work-items',
    operationId: 'listSprintWorkItems',
    summary: 'List a sprint’s members',
    description:
      'The items in a sprint, in rank order. ⚠️ Deliberately asymmetric with the backlog: done items STAY in their sprint, because that is what makes a completed sprint a historical record. Reports a total, because the read behind it already computes one.',
    scope: 'read',
    parameters: [sprintIdParameter, ...pageParameters(), filterParameter()],
    response: {
      status: 200,
      body: { kind: 'rankedPage', item: workItemRefSchema },
      description: 'A page of sprint members, with the total behind it.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/sprints/{sprintId}/work-items',
    operationId: 'moveWorkItemsToSprint',
    summary: 'Move work items into a sprint',
    description:
      'An atomic batch move into this sprint. An empty array is a 200 no-op; an item belonging to another project rejects the WHOLE batch before any write, so a partial move cannot happen.',
    scope: 'sprints:write',
    parameters: [sprintIdParameter],
    requestBody: { schema: membershipMoveBodySchema, description: 'The work items to move.' },
    response: {
      status: 200,
      body: { kind: 'object', schema: membershipMoveResultSchema },
      description: 'The keys that moved, in request order.',
    },
    errorStatuses: [403, 404, 422],
  }),
];

/** The named component schemas these resources contribute to the document. */
export const PLANNING_COMPONENTS: Readonly<Record<string, ZodType>> = {
  Me: meSchema,
  WorkspaceSummary: workspaceSummarySchema,
  Project: projectSchema,
  Sprint: sprintSchema,
  ReadyItem: readyItemSchema,
  MembershipMoveResult: membershipMoveResultSchema,
  WorkItemRef: workItemRefSchema,
};
