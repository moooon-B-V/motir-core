import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';

// GET /api/pages/[pageId]/work-items?cursor=&limit= (Story MOTIR-7567 · MOTIR-9198)
// — a page's hand-linked work items, newest link first: `{ rows, nextCursor,
// canLink }`, each row `{ workItemId, linkedAt, summary }`. Read-only. The project
// comes from the active-project context; a page in any other project answers as
// unknown. `canLink` is an affordance — the write re-checks `work_item:edit`.

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

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? null : Number(rawLimit);

  try {
    const dto = await pageLinksService.listWorkItemsForPage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      {
        projectId: ctx.projectId,
        pageId,
        cursor: url.searchParams.get('cursor'),
        limit: limit !== null && Number.isFinite(limit) ? limit : null,
      },
    );
    return NextResponse.json(dto);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
