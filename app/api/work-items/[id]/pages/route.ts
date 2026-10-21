import { NextResponse } from 'next/server';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/[id]/pages?cursor=&limit= (Story MOTIR-7565 · MOTIR-7573)
// — the pages that link to a work item, one row per page with every way it
// links, its place and its `state` (`unavailable` once archived), newest edit
// first, keyset-paged (50 by default, at most 100). Thin HTTP layer over `pageLinksService.listPagesForWorkItem`; no db, no
// transaction, no business logic here (CLAUDE.md route layer).
//
// Typed errors → status codes:
//   WorkItemNotFoundError                 → 404 (unknown, another workspace, or a
//                                                project the reader cannot browse)
//   ProjectAccessDeniedError ('edit')     → 403 (no `page:view` on the project)
//   PageLevelCursorInvalidError           → 400 (a cursor this read did not issue)
//
// POST /api/work-items/[id]/pages { pageId } (Story MOTIR-7567 · MOTIR-9197) —
// link a page to the work item by hand: 200 with the pair, `work_item:edit` and
// `page:view` required. The body carries `pageId` ONLY; a `source` in it is
// ignored, so this door can never mint a derived source. Refusals through
// `pageErrorResponse`: PAGE_LINK_ALREADY_LINKED 409, PAGE_ARCHIVED 409,
// PAGE_NOT_FOUND 404, 403 without a capability; WorkItemNotFoundError → 404.

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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  let pageId: unknown;
  try {
    pageId = ((await req.json()) as { pageId?: unknown } | null)?.pageId;
  } catch {
    return badRequest('The body must be JSON.');
  }
  if (typeof pageId !== 'string' || pageId === '') return badRequest('`pageId` is required.');

  try {
    return NextResponse.json(
      await pageLinksService.linkPageForWorkItem(ctx, { workItemId: id, pageId }),
    );
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    return pageErrorResponse(err);
  }
}

function badRequest(error: string): Response {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}
