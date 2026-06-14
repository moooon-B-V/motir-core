import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';

// POST /api/work-items/[id]/triage/promote (Subtask 6.11.5) — promote a triage
// submission into the planned tree under a chosen destination (epic/story
// parent and/or sprint, optionally positioned between neighbours), clearing the
// triage marker. Thin HTTP layer over triageService.promoteTriageItem. No db /
// no transaction here (CLAUDE.md).
//
// Body: { parentId?: string | null, sprintId?: string | null,
//         beforeId?: string, afterId?: string, comment?: string }
//   parentId/sprintId omitted = leave as-is; `null` = backlog / no sprint.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = req.body ? await req.json() : {};
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { parentId, sprintId, beforeId, afterId, comment } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`parentId` must be a string or null.' },
      { status: 400 },
    );
  }
  if (sprintId !== undefined && sprintId !== null && typeof sprintId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`sprintId` must be a string or null.' },
      { status: 400 },
    );
  }
  for (const [key, val] of [
    ['beforeId', beforeId],
    ['afterId', afterId],
    ['comment', comment],
  ] as const) {
    if (val !== undefined && typeof val !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: `\`${key}\` must be a string.` },
        { status: 400 },
      );
    }
  }

  try {
    const item = await triageService.promoteTriageItem(
      id,
      {
        parentId: parentId as string | null | undefined,
        sprintId: sprintId as string | null | undefined,
        beforeId: beforeId as string | undefined,
        afterId: afterId as string | undefined,
        comment: comment as string | undefined,
      },
      ctx,
    );
    return NextResponse.json(item);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
