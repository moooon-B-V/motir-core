import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { backlogService } from '@/lib/services/backlogService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// POST /api/work-items/[id]/rank (Subtask 4.1.4) — reorder an issue within its
// current scope (its sprint, or the backlog) by dropping it between two
// neighbours. Thin HTTP layer over backlogService.rankIssue; the issue id is the
// path param, workspace + actor from the session context. The reorder is a
// single fractional-index write (no N-row renumber). No db / no transaction here
// (CLAUDE.md).
//
// Body: { beforeId?, afterId? } — the neighbours the issue lands between
// (absent `beforeId` = drop at top; absent `afterId` = drop at bottom).
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (the issue or a named neighbour)
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

  const { beforeId, afterId } = (body ?? {}) as Record<string, unknown>;
  if (beforeId !== undefined && typeof beforeId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`beforeId` must be a string.' },
      { status: 400 },
    );
  }
  if (afterId !== undefined && typeof afterId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`afterId` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const item = await backlogService.rankIssue(id, { beforeId, afterId }, ctx);
    return NextResponse.json(item);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
