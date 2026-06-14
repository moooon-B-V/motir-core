import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';

// /api/work-items/[id]/triage/snooze (Subtask 6.11.5) — defer a triage
// submission out of the ACTIVE queue.
//   POST   { snoozedUntil: ISO-8601 } → snooze until that instant (or until new
//           activity returns it sooner, per the addComment hook).
//   DELETE                            → unsnooze (clear `snoozedUntil` now).
// Thin HTTP layer over triageService.snooze/unsnoozeTriageItem. No db / no
// transaction here (CLAUDE.md).
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

  const { snoozedUntil } = (body ?? {}) as Record<string, unknown>;
  if (typeof snoozedUntil !== 'string' || snoozedUntil.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`snoozedUntil` is required and must be an ISO-8601 string.' },
      { status: 400 },
    );
  }

  try {
    const item = await triageService.snoozeTriageItem(id, { snoozedUntil }, ctx);
    return NextResponse.json(item);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    const item = await triageService.unsnoozeTriageItem(id, ctx);
    return NextResponse.json(item);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
