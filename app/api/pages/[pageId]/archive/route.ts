import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';

// POST / DELETE /api/pages/[pageId]/archive (Story MOTIR-5755 · MOTIR-7422) —
// the work-item archive route's shape (`app/api/work-items/[id]/archive`):
// `POST` archives the page with every live sub-page under it, `DELETE` restores
// an archive root and its set. Both `page:edit`. No body. The project comes from
// the active-project context; a page in any other project answers as unknown.
// Thin: gate → one service call → map.

type Params = { params: Promise<{ pageId: string }> };

function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 400 },
  );
}

/** Archive — answers `{ archivedIds, rootId, subPageCount }`. */
export async function POST(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  try {
    const result = await pagesService.archivePage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId },
    );
    return NextResponse.json(result);
  } catch (err) {
    return pageErrorResponse(err);
  }
}

/** Restore — answers `{ restoredIds, landing }`, the landing named for the notice. */
export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  try {
    const result = await pagesService.restorePage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId },
    );
    return NextResponse.json(result);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
