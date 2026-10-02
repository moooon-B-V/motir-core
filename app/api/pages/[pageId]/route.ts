import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';

// GET / PATCH /api/pages/[pageId] (Story MOTIR-5752 · MOTIR-7278) — read a page
// (its `PageDto`, the state base64) and rename it. The project comes from the
// active-project context; a page in any other project answers as unknown.

type Params = { params: Promise<{ pageId: string }> };

function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 400 },
  );
}

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  try {
    const page = await pagesService.getPage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId },
    );
    return NextResponse.json(page);
  } catch (err) {
    return pageErrorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId } = await params;

  let title: unknown;
  try {
    title = ((await req.json()) as { title?: unknown } | null)?.title;
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Expected JSON.' }, { status: 400 });
  }
  if (typeof title !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a string `title`.' },
      { status: 400 },
    );
  }

  try {
    const page = await pagesService.renamePage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, title },
    );
    return NextResponse.json({ title: page.title });
  } catch (err) {
    return pageErrorResponse(err);
  }
}
