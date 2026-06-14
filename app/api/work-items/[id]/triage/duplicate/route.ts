import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';

// POST /api/work-items/[id]/triage/duplicate (Subtask 6.11.5) — mark a triage
// submission as a duplicate of a canonical item: fold its comments +
// attachments into the canonical item, record a `duplicates` link, and cancel
// the duplicate (marker KEPT). Thin HTTP layer over
// triageService.markDuplicateTriageItem. No db / no transaction here (CLAUDE.md).
//
// Body: { canonicalId: string, comment?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { canonicalId, comment } = (body ?? {}) as Record<string, unknown>;
  if (typeof canonicalId !== 'string' || canonicalId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`canonicalId` is required and must be a string.' },
      { status: 400 },
    );
  }
  if (comment !== undefined && typeof comment !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`comment` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const item = await triageService.markDuplicateTriageItem(id, { canonicalId, comment }, ctx);
    return NextResponse.json(item);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
