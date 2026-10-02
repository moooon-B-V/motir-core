import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { parseParentBody } from '@/lib/pages/parentInput';
import type { PageParentInput } from '@/lib/dto/pages';

// POST /api/pages (Story MOTIR-5752 · MOTIR-7278) — create an empty page at the
// active project's root. Optional JSON body `{ title }`. The project comes from
// the active-project context, never the payload. Thin: gate → service → map.

export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 400 },
    );
  }

  let title: string | undefined;
  let parent: PageParentInput | undefined;
  const raw = await req.text();
  if (raw.trim() !== '') {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ code: 'BAD_REQUEST', error: 'Expected JSON.' }, { status: 400 });
    }
    const candidate = (body as { title?: unknown } | null)?.title;
    if (candidate !== undefined && typeof candidate !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`title` must be a string.' },
        { status: 400 },
      );
    }
    title = candidate;
    const rawParent = (body as { parent?: unknown } | null)?.parent;
    if (rawParent !== undefined) {
      const parsed = parseParentBody(rawParent);
      if (!parsed) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`parent` must be { kind, id? }.' },
          { status: 400 },
        );
      }
      parent = parsed;
    }
  }

  try {
    const page = await pagesService.createPage(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, title, parent },
    );
    return NextResponse.json({ id: page.id }, { status: 201 });
  } catch (err) {
    return pageErrorResponse(err);
  }
}
