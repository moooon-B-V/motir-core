import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import {
  createFolderBodySchema,
  folderDeletionSchema,
  folderSchema,
  updateFolderBodySchema,
} from '@/lib/api/v1/folders/schema';
import { v1CursorSchema } from '@/lib/api/v1/openapi/envelopes';
import {
  defineOperation,
  type V1Operation,
  type V1Parameter,
} from '@/lib/api/v1/openapi/operation';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';

// The FOLDER operations (Story MOTIR-5310 · MOTIR-5408).
//
// Read off the two routes (`app/api/v1/projects/[projectKey]/folders/route.ts`,
// `app/api/v1/folders/[folderId]/route.ts`), not off a neighbour: the permission
// from each `withV1Route`, the query parameters from what the handler parses, and
// the error statuses from the service refusals each operation can reach.
// `tests/api/v1/openapi-operations-coverage.test.ts` fails on a route method with
// no declaration here.
//
// ⚠️ The MCP's folder tools describe the SAME operations, with the same
// rename-OR-placement split on update. If one door changes that split, the other
// has to.

const projectKeyParameter: V1Parameter = {
  name: 'projectKey',
  in: 'path',
  required: true,
  description: 'The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`.',
  schema: z.string().min(1),
};

const folderIdParameter: V1Parameter = {
  name: 'folderId',
  in: 'path',
  required: true,
  description:
    'The folder’s id. A folder has no `MOTIR-<n>` key, so its id is its name on the wire.',
  schema: z.string().min(1),
};

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

export const FOLDER_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/folders',
    operationId: 'listFolders',
    summary: 'List one level of a project’s folders',
    description:
      'The CHILD folders of one level, in the order the tree shows them — the project root by default, or `parentFolderId`’s children. The tree is read level by level: walk down by listing a folder’s children. Each row carries its `path`, root first. A `parentFolderId` that is not a folder of this project is `FOLDER_NOT_FOUND`.',
    permission: 'project:browse',
    parameters: [
      projectKeyParameter,
      {
        name: 'parentFolderId',
        in: 'query',
        required: false,
        description: 'List this folder’s child folders. Omit (or send empty) for the project root.',
        schema: z.string(),
      },
      ...pageParameters(),
    ],
    response: {
      status: 200,
      body: { kind: 'page', item: folderSchema },
      description: 'A page of folders at that level.',
    },
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/folders',
    operationId: 'createFolder',
    summary: 'Create a folder',
    description:
      'Create a folder at the project root or inside `parentFolderId`, appended last among its siblings. A sibling already holding the name (case-insensitively) is `FOLDER_NAME_TAKEN` (409); an empty or over-long name is `INVALID_FOLDER_NAME`; a parent in another project is `CROSS_PROJECT_FOLDER`. The `Location` header names the created folder.',
    permission: 'work_item:edit',
    parameters: [projectKeyParameter],
    requestBody: { schema: createFolderBodySchema, description: 'The folder to create.' },
    response: {
      status: 201,
      body: { kind: 'object', schema: folderSchema },
      description: 'The created folder.',
    },
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/folders/{folderId}',
    operationId: 'getFolder',
    summary: 'Read a folder',
    description:
      'One folder by id, with its project key and path. A folder in another workspace, one in a project this token is not bound to, and one that never existed are the same 404 — the existence-oracle rule.',
    permission: 'project:browse',
    parameters: [folderIdParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: folderSchema },
      description: 'The folder.',
    },
    errorStatuses: [404],
  }),
  defineOperation({
    method: 'PATCH',
    path: '/api/v1/folders/{folderId}',
    operationId: 'updateFolder',
    summary: 'Rename, move or reorder a folder',
    description:
      'A RENAME (`name`) OR a PLACEMENT (`parentFolderId`, `beforeId`, `afterId`) — never both in one request, because the two are applied separately and a combined request could half-apply; sending both is a 422 `INVALID_REQUEST`. A placement with no `parentFolderId` keeps the current parent (a pure reorder). Moving a folder into itself or one of its own folders is `FOLDER_CYCLE`; a destination in another project is `CROSS_PROJECT_FOLDER`; a name clash at the destination is `FOLDER_NAME_TAKEN`. There is no `If-Match`: folders carry no concurrency token.',
    permission: 'work_item:edit',
    parameters: [folderIdParameter],
    requestBody: {
      schema: updateFolderBodySchema,
      description: 'Either the new name, or the new placement.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: folderSchema },
      description: 'The folder after the change.',
    },
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'DELETE',
    path: '/api/v1/folders/{folderId}',
    operationId: 'deleteFolder',
    summary: 'Delete a folder, moving its contents up',
    description:
      'Delete a folder. NOTHING inside it is deleted: its child folders and filed work items move to the folder’s own parent (or the project root), and the body names them. Refused whole, changing nothing, when a child folder’s name collides at the destination (`FOLDER_NAME_TAKEN`) or when a ROOT folder holds a subtask that would be left with neither a parent nor a folder (`SUBTASK_NEEDS_PLACEMENT`).',
    permission: 'work_item:edit',
    parameters: [folderIdParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: folderDeletionSchema },
      description: 'What the delete moved, and where.',
    },
    errorStatuses: [403, 404, 409],
  }),
];

export const FOLDER_COMPONENTS: Readonly<Record<string, ZodType>> = {
  Folder: folderSchema,
  FolderDeletion: folderDeletionSchema,
};
