import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { parseParentBody } from '@/lib/pages/parentInput';

// PATCH /api/pages/[pageId]/placement (Story MOTIR-5753 · MOTIR-7372) — move a
// page (with its subtree): `{ parent: { kind, id? }, beforeId?, afterId? }`, the
// same neighbour shape `PATCH /api/v1/folders/{id}` takes. Answers the page's new
// placement. Thin: gate → one service call → map.

type Params = { params: Promise<{ pageId: string }> };

function bad(error: string): NextResponse {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

function optionalId(v: unknown): string | null | false {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v !== '' ? v : false;
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }
  const { pageId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Expected JSON.');
  }
  if (typeof body !== 'object' || body === null) return bad('Expected a JSON object.');
  const parent = parseParentBody((body as { parent?: unknown }).parent);
  if (!parent) return bad('`parent` must be { kind, id? }.');
  const beforeId = optionalId((body as { beforeId?: unknown }).beforeId);
  const afterId = optionalId((body as { afterId?: unknown }).afterId);
  if (beforeId === false || afterId === false) {
    return bad('`beforeId` and `afterId` must be page ids.');
  }

  try {
    const placement = await pagesService.movePage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, parent, beforeId, afterId },
    );
    return NextResponse.json(placement);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
