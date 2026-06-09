import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { estimationService } from '@/lib/services/estimationService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { InvalidEstimateError } from '@/lib/estimation/errors';

// PATCH /api/work-items/[id]/estimate (Story 4.3 · Subtask 4.3.3) — set or clear
// an issue's STORY-POINT estimate (separate from the 2.3.6 TIME estimate). Thin
// HTTP layer over estimationService; the issue id is the path param, the
// workspace + actor come from the session context. No db / no transaction here
// (CLAUDE.md).
//
// Body: { points: number | null }   (a non-negative number, or null to clear)
//
// Typed errors → status codes:
//   WorkItemNotFoundError  → 404
//   InvalidEstimateError   → 422
export async function PATCH(
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

  const { points } = (body ?? {}) as Record<string, unknown>;
  if (points !== null && typeof points !== 'number') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`points` must be a number or null.' },
      { status: 400 },
    );
  }

  try {
    const item = await estimationService.setEstimate(id, points, ctx);
    return NextResponse.json(item);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidEstimateError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
