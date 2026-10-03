import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { parseParentParam } from '@/lib/pages/parentInput';

// GET /api/pages/tree (Story MOTIR-5753 · MOTIR-7372) — ONE level of the pages
// tree: `?projectKey=&parent=root|folder:<id>|page:<id>&cursor=&limit=`. Folders
// first, then pages; `nextCursor` continues the level. `projectKey` names a
// project of the active workspace (omitted, the active project); one the caller
// cannot browse answers as unknown. Thin: gate → one service call → map.

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
  const parent = parseParentParam(url.searchParams.get('parent') ?? 'root');
  if (!parent) return bad('`parent` must be root, folder:<id> or page:<id>.');

  let limit: number | undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1)
      return bad('`limit` must be a positive integer.');
    limit = Number(rawLimit);
  }
  const cursor = url.searchParams.get('cursor') || undefined;

  const ctx = { userId: active.userId, workspaceId: active.workspaceId };
  try {
    let projectId = active.projectId;
    const key = url.searchParams.get('projectKey');
    if (key && key.toUpperCase() !== active.project.identifier.toUpperCase()) {
      projectId = (await projectsService.resolveByKey(key, ctx)).project.id;
    }
    const level = await pagesService.listTreeLevel(ctx, { projectId, parent, cursor, limit });
    return NextResponse.json(level);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
