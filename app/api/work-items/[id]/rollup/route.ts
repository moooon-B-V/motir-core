import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { estimationService } from '@/lib/services/estimationService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[id]/rollup (Story 4.3 · Subtask 4.3.5) — the BOUNDED
// epic/parent subtree roll-up (`{ total }`) the list/tree parent row binds to
// (the issue-detail header computes the same figure server-side). Thin HTTP
// layer over `estimationService.rollupForParent`; the parent id is the path
// param, the workspace + actor come from the session context. The aggregate is
// statistic-aware and a single recursive-CTE SUM over the descendants — never a
// load-the-subtree + client sum (finding #57). No db / no transaction here
// (CLAUDE.md); a read open to any project member.
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (unknown / cross-workspace parent, no existence leak)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    const rollup = await estimationService.rollupForParent(id, ctx);
    return NextResponse.json(rollup);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
