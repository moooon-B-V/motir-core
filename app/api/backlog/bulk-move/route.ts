import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { backlogService } from '@/lib/services/backlogService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { BulkBatchTooLargeError } from '@/lib/sprints/errors';

// POST /api/backlog/bulk-move (Subtask 4.2.2) — move a multi-selection of issues
// back to the backlog ATOMICALLY (the "Move to backlog" bulk action). Thin HTTP
// layer over backlogService.bulkMoveToBacklog: the issues name their OWN project,
// so the workspace + actor from the session context is the only gate needed (the
// service workspace-gates every member) — no active-project coupling, same shape
// as the single-issue /api/work-items/[id]/sprint route. The whole batch moves in
// one transaction or none does. No db / no transaction here (CLAUDE.md).
//
// Body: { itemIds: string[] }  → bulkMoveToBacklog
//
// Typed errors → status codes:
//   BulkBatchTooLargeError  → 400
//   WorkItemNotFoundError   → 404
export async function POST(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { itemIds } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(itemIds) || !itemIds.every((x) => typeof x === 'string')) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`itemIds` must be an array of strings.' },
      { status: 400 },
    );
  }

  try {
    const items = await backlogService.bulkMoveToBacklog(itemIds as string[], ctx);
    return NextResponse.json({ items });
  } catch (err) {
    if (err instanceof BulkBatchTooLargeError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
