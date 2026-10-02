import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { badIntegerResponse, pageErrorResponse, parsePositiveInt } from '@/lib/pages/routeErrors';

// GET /api/pages/[pageId]/versions?before=<n>&limit=<n> (Story MOTIR-5754 ·
// MOTIR-7386) — one page of the page's history, newest first, as
// `{ items, nextBefore }`. The service caps `limit`; a malformed one is 400.

type Params = { params: Promise<{ pageId: string }> };

function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 400 },
  );
}

export async function GET(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  const query = new URL(req.url).searchParams;
  const rawBefore = query.get('before');
  const rawLimit = query.get('limit');
  const before = rawBefore === null ? undefined : parsePositiveInt(rawBefore);
  if (before === null) return badIntegerResponse('before');
  const limit = rawLimit === null ? undefined : parsePositiveInt(rawLimit);
  if (limit === null) return badIntegerResponse('limit');

  try {
    const page = await pagesService.listPageVersions(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, before, limit },
    );
    return NextResponse.json(page);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
