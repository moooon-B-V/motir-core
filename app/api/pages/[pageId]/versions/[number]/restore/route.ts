import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { pagesService } from '@/lib/services/pagesService';
import { badIntegerResponse, pageErrorResponse, parsePositiveInt } from '@/lib/pages/routeErrors';

// POST /api/pages/[pageId]/versions/[number]/restore (Story MOTIR-5754 ·
// MOTIR-7386) — make that version the page's content as a NEW version, under
// `page:edit`. No body. Answers `{ revision, version, bodyState }` so the open
// editor re-seeds without a second read.

type Params = { params: Promise<{ pageId: string; number: string }> };

function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 400 },
  );
}

export async function POST(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();
  const { pageId, number: rawNumber } = await params;
  const number = parsePositiveInt(rawNumber);
  if (number === null) return badIntegerResponse('number');

  try {
    const restored = await pagesService.restorePageVersion(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { projectId: ctx.projectId, pageId, number },
    );
    return NextResponse.json(restored);
  } catch (err) {
    return pageErrorResponse(err);
  }
}
