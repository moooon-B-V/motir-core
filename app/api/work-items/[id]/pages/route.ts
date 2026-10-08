import { NextResponse } from 'next/server';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/[id]/pages?cursor=&limit= (Story MOTIR-7565 · MOTIR-7573)
// — the live pages that link to a work item, one row per page with every way it
// links and its place, newest edit first, keyset-paged (50 by default, at most
// 100). Thin HTTP layer over `pageLinksService.listPagesForWorkItem`; no db, no
// transaction, no business logic here (CLAUDE.md route layer).
//
// Typed errors → status codes:
//   WorkItemNotFoundError                 → 404 (unknown, another workspace, or a
//                                                project the reader cannot browse)
//   ProjectAccessDeniedError ('edit')     → 403 (no `page:view` on the project)
//   PageLevelCursorInvalidError           → 400 (a cursor this read did not issue)

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const search = new URL(req.url).searchParams;
  const rawLimit = search.get('limit');

  try {
    const page = await pageLinksService.listPagesForWorkItem(ctx, {
      workItemId: id,
      cursor: search.get('cursor'),
      limit: rawLimit === null ? null : Number(rawLimit),
    });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    return pageErrorResponse(err);
  }
}
