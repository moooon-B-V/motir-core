import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// POST   /api/work-items/[id]/archive — soft-archive a work item (reversible,
//        single-node: descendants stay live; the "Linear shape").
// DELETE /api/work-items/[id]/archive — UNARCHIVE (restore) — the inverse, the
//        "Undo" the 2.8.4 actions menu offers after an archive.
//
// Both are thin HTTP layers over workItemsService.archiveWorkItem /
// unarchiveWorkItem (Story 2.8 · Subtask 2.8.4 surfaces the existing service in
// the web UI; the service shipped earlier + via the MCP). The item id is the
// path param, the workspace + actor come from the session context. Archive is
// the EDIT gate (`canEdit`) — distinct from the project-admin DELETE gate.
// No db / no transaction / no business logic here (CLAUDE.md route layer).
//
// Typed errors → status codes:
//   WorkItemNotFoundError                  → 404 (unknown / cross-workspace item)
//   ProjectAccessDeniedError (kind browse) → 404 (project not browseable — no-existence-leak)
//   ProjectAccessDeniedError (kind edit)   → 403 (read-only actor)
//   ProjectNotFoundError                   → 404
function mapError(err: unknown): Response {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message },
      { status: err.kind === 'browse' ? 404 : 403 },
    );
  }
  throw err;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const item = await workItemsService.archiveWorkItem(id, ctx);
    return NextResponse.json(item);
  } catch (err) {
    return mapError(err);
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
    const item = await workItemsService.unarchiveWorkItem(id, ctx);
    return NextResponse.json(item);
  } catch (err) {
    return mapError(err);
  }
}
