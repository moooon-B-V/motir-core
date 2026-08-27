import { NextResponse } from 'next/server';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/work-items/[id]/triage/decline (Subtask 6.11.5) — decline a triage
// submission: move it to the terminal `cancelled` status (the marker is KEPT so
// it never enters the tree) with an optional comment. Thin HTTP layer over
// triageService.declineTriageItem. No db / no transaction here (CLAUDE.md).
//
// Body: { comment?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

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
    const item = await triageService.declineTriageItem(id, { comment }, ctx);
    return NextResponse.json(item);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
