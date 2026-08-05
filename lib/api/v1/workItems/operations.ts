import { z } from 'zod/v4';
import { FILTER_PARAM } from '@/lib/filters/ast';
import { v1CursorSchema } from '@/lib/api/v1/openapi/envelopes';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import {
  commentThreadSchema,
  createWorkItemBodySchema,
  relationshipSchema,
  transitionListSchema,
  updateWorkItemBodySchema,
  workItemDetailSchema,
  workItemKeySchema,
  workItemLinkGroupsSchema,
  workItemSummarySchema,
} from '@/lib/api/v1/workItems/schema';

// The WORK-ITEM operations (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// Declared BESIDE the schemas they use, in the module ADR Amendment 2 gave the
// resource and Amendment 4 Q2 gave the operations: *"a per-resource
// `operations.ts` beside each `schema.ts` … assembled by one registry"*. The
// alternative — one central file listing every endpoint — is the file Amendment
// 2 refused for shapes, rebuilt for operations: a second place to update when a
// route changes, updated by someone other than whoever changed the route.
//
// ⚠️ The `scope` on each operation MUST equal the one its route file declares
// to `withV1Route`. It is written here so the DOCUMENT can state it; Subtask
// 11.4.6 asserts the equality against the route tree. Neither reads the other at
// request time.
//
// Paths are the OpenAPI templates a client calls, so `[key]` in the filesystem
// is `{key}` here.

/** The shared cursor + limit query parameters, on every collection. */
const pageParameters = [
  {
    name: 'cursor',
    in: 'query' as const,
    required: false,
    description:
      'An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. A cursor is signed and scoped to its collection — one issued elsewhere is a 422, never a silent reset.',
    schema: v1CursorSchema,
  },
  {
    name: 'limit',
    in: 'query' as const,
    required: false,
    description: `Rows per page. Defaults to ${DEFAULT_PAGE_LIMIT}; a larger value is CLAMPED to ${MAX_PAGE_LIMIT} rather than rejected.`,
    schema: z.number().int().positive(),
  },
];

/** The `{key}` path parameter every single-item work-item route takes. */
const keyParameter = {
  name: 'key',
  in: 'path' as const,
  required: true,
  description: 'The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7).',
  schema: workItemKeySchema,
};

/** The `{projectKey}` path parameter the project-scoped collection takes. */
const projectKeyParameter = {
  name: 'projectKey',
  in: 'path' as const,
  required: true,
  description: 'The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`.',
  schema: z.string().min(1),
};

/**
 * `If-Match`, the HTTP-native optimistic-concurrency guard on the one write
 * that has one. Omitting it is LEGAL and means last-write-wins.
 */
const ifMatchParameter = {
  name: 'If-Match',
  in: 'header' as const,
  required: false,
  description:
    'An `ETag` from a previous read of this work item. When present, the update is refused with 412 if the item moved since that read. Omitting it means last-write-wins.',
  schema: z.string().min(1),
};

/** Every work-item operation, in the order the reference lists them. */
export const WORK_ITEM_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/work-items',
    operationId: 'listProjectWorkItems',
    summary: 'List a project’s work items',
    description:
      'A cursor-paged collection of a project’s work items, optionally narrowed by a filter expression. Ordered by `(createdAt, id)` ascending — the position the cursor encodes.',
    scope: 'read',
    parameters: [
      projectKeyParameter,
      ...pageParameters,
      {
        name: FILTER_PARAM,
        in: 'query',
        required: false,
        description:
          'A serialised filter expression, in the same form the product’s own list views use. An unknown field, operator or value is a 422 naming which.',
        schema: z.string().min(1),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'page', item: workItemSummarySchema },
      description: 'A page of work-item summaries.',
    },
    // The plain envelope: this collection reports no total, because the read
    // behind it does not compute one as a bounded aggregate (ADR Amendment 3 Q2).
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/work-items',
    operationId: 'createWorkItem',
    summary: 'Create a work item',
    description:
      'Create a work item in a project. The parent, if given, is named by its key and must be a kind-legal parent in the same project.',
    scope: 'work_items:write',
    parameters: [projectKeyParameter],
    requestBody: {
      schema: createWorkItemBodySchema,
      description: 'The work item to create.',
    },
    response: {
      status: 201,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The created work item.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}',
    operationId: 'getWorkItem',
    summary: 'Read a work item',
    description:
      'The full work item: its own fields, its parent and children, its five link groups, its readiness verdict and its comment count. The response carries an `ETag` for use as an `If-Match` on a later update.',
    scope: 'read',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The work item.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'PATCH',
    path: '/api/v1/work-items/{key}',
    operationId: 'updateWorkItem',
    summary: 'Update a work item',
    description:
      'Patch any subset of a work item’s fields. A field that is ABSENT is untouched; a field explicitly set to `null` CLEARS it. Send `If-Match` to make the update conditional on the item not having moved.',
    scope: 'work_items:write',
    parameters: [keyParameter, ifMatchParameter],
    requestBody: {
      schema: updateWorkItemBodySchema,
      description: 'The fields to change.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The updated work item.',
    },
    errorStatuses: [404, 412, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/transitions',
    operationId: 'listWorkItemTransitions',
    summary: 'List the statuses a work item can move to',
    description:
      'The workflow-legal targets from the item’s current status. An `open`-policy project permits every other status; a `restricted` one permits only the declared edges.',
    scope: 'read',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: transitionListSchema },
      description: 'The legal transition targets.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/transitions',
    operationId: 'transitionWorkItem',
    summary: 'Move a work item to a new status',
    description:
      'Apply a workflow transition. A status the workflow does not define and a status not reachable from here are DIFFERENT errors, because a client can fix only one of them.',
    scope: 'work_items:write',
    parameters: [keyParameter],
    requestBody: {
      schema: z.object({ status: z.string().min(1) }).strict(),
      description: 'The target status key.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The work item at its new status.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/links',
    operationId: 'listWorkItemLinks',
    summary: 'Read a work item’s relationship edges',
    description:
      'All five edge groups. An empty group is `[]`, never an absent key — to a typed client those are different things.',
    scope: 'read',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemLinkGroupsSchema },
      description: 'The five edge groups.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/links',
    operationId: 'createWorkItemLink',
    summary: 'Create a relationship edge',
    description:
      'Link this work item to another by key. Creating an edge that already exists is a 409 — the body is valid, the state is not what the request assumed.',
    scope: 'work_items:write',
    parameters: [keyParameter],
    requestBody: {
      schema: z.object({ toKey: workItemKeySchema, relationship: relationshipSchema }).strict(),
      description: 'The other endpoint and the relationship.',
    },
    response: {
      status: 201,
      body: {
        kind: 'object',
        schema: z.object({ toKey: workItemKeySchema, relationship: relationshipSchema }),
      },
      description: 'The created edge.',
    },
    errorStatuses: [404, 409, 422],
  }),
  defineOperation({
    method: 'DELETE',
    path: '/api/v1/work-items/{key}/links',
    operationId: 'deleteWorkItemLink',
    summary: 'Remove a relationship edge',
    description:
      'Remove the edge named by its ENDPOINTS — the same pair that created it. Idempotent: 204 whether or not an edge was there, because the post-condition holds either way.',
    scope: 'work_items:write',
    parameters: [
      keyParameter,
      {
        name: 'toKey',
        in: 'query',
        required: true,
        description: 'The other endpoint’s key.',
        schema: workItemKeySchema,
      },
      {
        name: 'relationship',
        in: 'query',
        required: true,
        description: 'The relationship to remove.',
        schema: relationshipSchema,
      },
    ],
    response: { status: 204, body: { kind: 'empty' }, description: 'The edge does not exist.' },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/comments',
    operationId: 'listWorkItemComments',
    summary: 'List a work item’s comments',
    description:
      'Root comments with their single-level reply threads, cursor-paged. This collection DOES report a total, because the shipped read computes it as a bounded aggregate.',
    scope: 'read',
    parameters: [
      keyParameter,
      ...pageParameters,
      {
        name: 'order',
        in: 'query',
        required: false,
        description: 'Root-comment order — `asc` (oldest first, the default) or `desc`.',
        schema: z.enum(['asc', 'desc']),
      },
    ],
    response: {
      status: 200,
      // The RANKED envelope — the one carrying `totalCount`.
      body: { kind: 'rankedPage', item: commentThreadSchema },
      description: 'A page of comment threads, with the total behind it.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/comments',
    operationId: 'createWorkItemComment',
    summary: 'Comment on a work item',
    description:
      'Add a root comment, or a reply by naming a root comment as its parent. Replies are single-level: a reply to a reply is a 422.',
    scope: 'work_items:write',
    parameters: [keyParameter],
    requestBody: {
      schema: z
        .object({ bodyMd: z.string().min(1), parentCommentId: z.string().min(1).optional() })
        .strict(),
      description: 'The comment to add.',
    },
    response: {
      status: 201,
      body: { kind: 'object', schema: commentThreadSchema.omit({ replies: true }) },
      description: 'The created comment.',
    },
    errorStatuses: [403, 404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/archive',
    operationId: 'archiveWorkItem',
    summary: 'Archive a work item',
    description:
      'A recoverable soft-remove. Does NOT cascade to children — the irreversible subtree delete is not exposed by this API at all (ADR §3).',
    scope: 'work_items:archive',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The archived work item.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/restore',
    operationId: 'restoreWorkItem',
    summary: 'Restore an archived work item',
    description: 'The inverse of archiving. Idempotent on an item that is not archived.',
    scope: 'work_items:archive',
    parameters: [keyParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemDetailSchema },
      description: 'The restored work item.',
    },
    errorStatuses: [404, 422],
  }),
];

/**
 * The named component schemas this resource contributes to the document.
 *
 * Registered so a shape used by several operations appears ONCE in
 * `components.schemas` and is `$ref`ed — which is what makes the emitted
 * document readable, and what a client generator turns into one named type
 * rather than N structural duplicates.
 */
export const WORK_ITEM_COMPONENTS: Readonly<Record<string, z.ZodType>> = {
  WorkItemSummary: workItemSummarySchema,
  WorkItemDetail: workItemDetailSchema,
  WorkItemLinkGroups: workItemLinkGroupsSchema,
  CommentThread: commentThreadSchema,
  TransitionList: transitionListSchema,
};
