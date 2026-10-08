import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';

// GET /api/pages/mention-search?projectId=<id>&q=<text> (Story MOTIR-7694 ·
// MOTIR-7697) — the candidate read behind the `@` picker's Pages section in a
// work item's Description and Explanation editors. HTTP only: the session, one
// service call, the shared page refusal map.
//
//   400  no `projectId`, or `q` shorter than QUICK_SEARCH_MIN_QUERY_LENGTH
//   403  a browser of the project without `page:view`
//   404  a project the caller cannot browse (the page routes' one not-found)
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const params = new URL(req.url).searchParams;
  const projectId = params.get('projectId') ?? '';
  const q = (params.get('q') ?? '').trim();
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
    return NextResponse.json(await pagesService.searchPagesForMention(ctx, { projectId, q }));
  } catch (err) {
    return pageErrorResponse(err);
  }
}
