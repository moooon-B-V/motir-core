import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';

// GET /api/pages/link-search?projectId=<id>&q=<text>&cursor=<opaque> (Story
// MOTIR-7567 · MOTIR-9204) — the paged candidate read behind the work item's
// Link page picker. HTTP only: the session, one service call, the shared page
// refusal map. The `@` popup keeps `GET /api/pages/mention-search`.
//
//   400  no `projectId`, `q` shorter than QUICK_SEARCH_MIN_QUERY_LENGTH, or a
//        cursor this service did not issue (`PAGE_CURSOR_INVALID`)
//   403  a browser of the project without `page:view`
//   404  a project the caller cannot browse (the page routes' one not-found)
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const params = new URL(req.url).searchParams;
  const projectId = params.get('projectId') ?? '';
  const q = (params.get('q') ?? '').trim();
  const cursor = params.get('cursor');
  if (projectId === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`projectId` is required.' },
      { status: 400 },
    );
  }
  if (q.length < QUICK_SEARCH_MIN_QUERY_LENGTH) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: `\`q\` must be at least ${QUICK_SEARCH_MIN_QUERY_LENGTH} characters.`,
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await pagesService.searchPagesForLink(ctx, { projectId, q, cursor }));
  } catch (err) {
    return pageErrorResponse(err);
  }
}
