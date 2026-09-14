import { NextResponse } from 'next/server';
import {
  createFolderBodySchema,
  presentFolder,
  readFolderLevelPosition,
  readParentFolderIdParam,
} from '@/lib/api/v1/folders/schema';
import { encodeCollectionCursor, parseCollectionPageRequest } from '@/lib/api/v1/pagination';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';

// GET /api/v1/projects/{projectKey}/folders (Story MOTIR-5310 · MOTIR-5408) —
// ONE LEVEL of a project's folders: the root's, or `?parentFolderId=`'s child
// folders, in the order the `/items` tree shows them.
//
// ── A level, not the tree ───────────────────────────────────────────────────
// The tree is lazy in the product, and the API reads it the same way: a client
// walks down by asking for a folder's children. A whole-tree dump would be a
// second read shape with its own bound to keep correct.
//
// ── Keyset over `(position, id)`, in the DATABASE ───────────────────────────
// A level is not a small bounded cadence the way a project's sprints are, so it
// is not read whole and sliced: `listFolderLevel` seeks after the cursor's
// `(position, id)` and reads one row past the page. `position` alone has no
// unique constraint (two concurrent creates can append the same key), which is
// why `id` breaks the tie and the order is total.
export const GET = withV1Route<{ projectKey: string }>(
  { permission: 'project:browse' },
  async (ctx) => {
    const page = parseCollectionPageRequest(ctx.req, 'folders', readFolderLevelPosition);
    const parentFolderId = readParentFolderIdParam(ctx.req);

    const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
    const result = await foldersService.listFolderLevel(
      {
        projectId: project.id,
        parentFolderId,
        limit: page.limit,
        ...(page.cursor ? { after: page.cursor } : {}),
      },
      ctx.service,
    );

    const last = result.folders[result.folders.length - 1];
    return NextResponse.json({
      items: result.folders.map(presentFolder),
      nextCursor:
        result.hasMore && last
          ? encodeCollectionCursor('folders', { position: last.position, id: last.id })
          : null,
    });
  },
);

// POST /api/v1/projects/{projectKey}/folders — create a folder at the root or
// inside `parentFolderId`, appended last among its siblings.
//
// Gated on `work_item:edit`, the key `foldersService` asserts for every folder
// write: a folder carries no workflow of its own, so arranging the tree is part
// of editing work. The name rule, the sibling-name rule and a parent in another
// project are all the service's refusals (`INVALID_FOLDER_NAME`,
// `FOLDER_NAME_TAKEN`, `CROSS_PROJECT_FOLDER`).
export const POST = withV1Route<{ projectKey: string }>(
  { permission: 'work_item:edit' },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, createFolderBodySchema);
    const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);

    const created = await foldersService.createFolder(
      { projectId: project.id, parentFolderId: body.parentFolderId ?? null, name: body.name },
      ctx.service,
    );
    const folder = await foldersService.getFolder(created.id, ctx.service);

    ctx.responseHeaders.set('Location', `/api/v1/folders/${folder.id}`);
    return NextResponse.json(presentFolder(folder), { status: 201 });
  },
);
