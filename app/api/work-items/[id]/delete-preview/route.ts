import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/work-items/[id]/delete-preview (Story 2.8 · Subtask 2.8.7) — the
// cascade IMPACT the delete-confirm dialog (2.8.4) reads BEFORE the user
// confirms: `{ totalCount, descendantCount, byKind }` over the item's subtree,
// PLUS the live (non-archived) split `{ liveDescendantCount, liveByKind }` the
// archived-item confirm (2.9.10) warns about (Subtask 2.9.9). Thin HTTP layer
// passing the service DTO straight through. The item id is the
// path param, the workspace + actor come from the session context. No db / no
// transaction here (CLAUDE.md). Gated on the same MANAGE capability the delete
// itself needs, so a viewer who can't delete can't probe the subtree shape.
//
// (The destructive DELETE on this same item lives at `[id]/route.ts`, Subtask
// 2.8.3 — kept a separate sub-path so the preview READ and the delete WRITE
// don't share a handler file.)
//
// Typed errors → status codes:
//   WorkItemNotFoundError → 404 (unknown / cross-workspace item — no existence leak)
//   ProjectNotFoundError  → 404 (actor can't even browse the project — stays hidden)
//   NotProjectAdminError  → 403 (browsable, but not delete-permitted — the 6.4 gate)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    const preview = await workItemsService.getDeletePreview(id, ctx);
    return NextResponse.json(preview);
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
