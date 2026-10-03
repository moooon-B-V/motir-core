import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';

// GET /api/pages/archived (Story MOTIR-5755 · MOTIR-7422) — the Archived pages
// list: `?projectKey=&cursor=&limit=`, archive roots newest first, each with
// where it came from. `page:view`. `limit` defaults to 50 and is held to 100 —
// the tree level's numbers, clamped where `tree/route.ts`'s are; a cursor the
// list did not issue is 400 `PAGE_CURSOR_INVALID`. `projectKey` names a project
// of the active workspace (omitted, the active project). A STATIC segment beside
// `[pageId]`, as `tree/` is. Thin: gate → one service call → map.

function bad(error: string): NextResponse {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const active = await getActiveProject();
  if (!active) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  let limit: number | undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1)
      return bad('`limit` must be a positive integer.');
    limit = Number(rawLimit);
  }
  const cursor = url.searchParams.get('cursor') || null;

  const ctx = { userId: active.userId, workspaceId: active.workspaceId };
  try {
    let projectId = active.projectId;
    const key = url.searchParams.get('projectKey');
    if (key && key.toUpperCase() !== active.project.identifier.toUpperCase()) {
      projectId = (await projectsService.resolveByKey(key, ctx)).project.id;
    }
    const list = await pagesService.listArchivedPages(ctx, { projectId, cursor, limit });
    return NextResponse.json(list);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
