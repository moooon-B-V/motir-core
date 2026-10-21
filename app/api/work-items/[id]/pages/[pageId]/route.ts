import { NextResponse } from 'next/server';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// DELETE /api/work-items/[id]/pages/[pageId] (Story MOTIR-7567 · MOTIR-9197) —
// remove the HAND link of the pair: 204 with no body. Only a `manual` row is
// matched, so a mention or an embed is never unlinked here. A DELETE never
// answers PAGE_ARCHIVED: a hand link whose page was archived since stays
// removable, and a pair with no hand link is PAGE_LINK_NOT_FOUND (404). Thin
// HTTP layer over `pageLinksService.unlinkPageForWorkItem`.

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; pageId: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id, pageId } = await params;
  try {
    await pageLinksService.unlinkPageForWorkItem(ctx, { workItemId: id, pageId });
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    return pageErrorResponse(err);
  }
}
