import { NextResponse } from 'next/server';
import {
  presentFolder,
  presentFolderDeletion,
  toUpdateFolderInput,
  updateFolderBodySchema,
} from '@/lib/api/v1/folders/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { foldersService } from '@/lib/services/foldersService';

// /api/v1/folders/{folderId} (Story MOTIR-5310 · MOTIR-5408) — one folder,
// addressed by the id the level list and the work-item placement hand out.
//
// ── 404, never 403, for a folder the token cannot reach ─────────────────────
// A folder in another workspace, a folder in a project the token is not BOUND
// to, and a folder that never existed are one answer: `FOLDER_NOT_FOUND`. The
// same rule `/api/v1/sprints/{sprintId}` follows (ADR §4's existence oracle), and
// it is decided in the service (`resolveAddressedFolder`), so the MCP's folder
// tools inherit it rather than restating it.

export const GET = withV1Route<{ folderId: string }>(
  { permission: 'project:browse' },
  async (ctx) => {
    const folder = await foldersService.getFolder(ctx.params.folderId, ctx.service);
    return NextResponse.json(presentFolder(folder));
  },
);

// PATCH — a RENAME (`{ name }`) or a PLACEMENT (`{ parentFolderId, beforeId?,
// afterId? }`), never both: the service does the two in separate transactions,
// so both together is a 422 `INVALID_REQUEST` naming the groups rather than a
// request that could half-apply. No `If-Match`: a folder carries no concurrency
// token, and this door does not invent one.
export const PATCH = withV1Route<{ folderId: string }>(
  { permission: 'work_item:edit' },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, updateFolderBodySchema);
    const folder = await foldersService.updateFolder(
      ctx.params.folderId,
      toUpdateFolderInput(body),
      ctx.service,
    );
    return NextResponse.json(presentFolder(folder));
  },
);

// DELETE — remove the folder and MOVE ITS CONTENTS UP to its own parent (or the
// root). Nothing inside a folder is deleted with it; the body names what moved.
// A 200 with that body rather than a 204, because the caller's next step is
// usually to update what it shows for exactly those rows.
export const DELETE = withV1Route<{ folderId: string }>(
  { permission: 'work_item:edit' },
  async (ctx) => {
    const result = await foldersService.deleteFolderById(ctx.params.folderId, ctx.service);
    return NextResponse.json(presentFolderDeletion(result));
  },
);
