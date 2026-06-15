import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';

// DELETE /api/work-items/[id] (Story 2.8 · Subtask 2.8.3) — PERMANENTLY delete a
// work item AND its entire subtree (Jira-parity "Delete Issues"). Thin HTTP layer
// over workItemsService.deleteWorkItem; the item id is the path param, the
// workspace + actor come from the session context. No db / no transaction / no
// business logic here (CLAUDE.md route layer).
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (unknown / cross-workspace / already-deleted item)
//   ProjectNotFoundError  → 404 (item's project not browseable — no-existence-leak,
//                                 the same rule assertCanManage follows)
//   NotProjectAdminError  → 403 (non-admin actor — delete is the project "manage" gate)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    await workItemsService.deleteWorkItem(id, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof NotProjectAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    throw err;
  }
}
