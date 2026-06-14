import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';

// POST /api/work-items/[id]/triage/accept (Subtask 6.11.5) — accept a triage
// submission into the project backlog (clear the triage marker, re-rank to the
// bottom), with an optional admin comment. Thin HTTP layer over
// triageService.acceptTriageItem; the item id is the path param, workspace +
// actor from the session context. No db / no transaction here (CLAUDE.md).
//
// Body: { comment?: string }
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

  const { comment } = (body ?? {}) as Record<string, unknown>;
  if (comment !== undefined && typeof comment !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`comment` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const item = await triageService.acceptTriageItem(id, { comment }, ctx);
    return NextResponse.json(item);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
