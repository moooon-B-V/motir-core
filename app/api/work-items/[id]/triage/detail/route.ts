import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService } from '@/lib/services/triageService';
import { triageActionErrorResponse } from '@/lib/triage/errorResponse';

// GET /api/work-items/[id]/triage/detail (Subtask 6.11.6) — the full triage
// item behind an inbox row click: the body + submitter + comment/attachment
// thread the detail pane renders. Thin HTTP layer over
// triageService.getTriageItemDetail; the item id is the path param, workspace +
// actor from the session context. No db / no transaction here (CLAUDE.md).
//
// Typed errors → status (via triageActionErrorResponse): a missing /
// cross-workspace / non-browsable id → 404; an item already graduated out of
// triage → 409.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    const detail = await triageService.getTriageItemDetail(id, ctx);
    return NextResponse.json(detail);
  } catch (err) {
    const mapped = triageActionErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
