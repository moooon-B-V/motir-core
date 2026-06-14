import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { workItemsService } from '@/lib/services/workItemsService';
import { NotEpicError, WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NotProjectAdminError } from '@/lib/projects/errors';

// PATCH /api/work-items/[id]/epic-privacy (Story 6.14 · Subtask 6.14.7) — the
// project-admin write that sets/unsets an EPIC's `publicChildrenHidden` privacy
// flag. Thin HTTP layer over workItemsService.setEpicPrivacy; the item id is the
// path param, the workspace + actor come from the session context. No db / no
// transaction here (CLAUDE.md).
//
// Body: { publicChildrenHidden: boolean }
//
// Typed errors → status codes:
//   WorkItemNotFoundError   → 404 (unknown / cross-workspace item)
//   NotProjectAdminError    → 403 (non-admin actor — the 6.4 gate)
//   NotEpicError            → 422 (target is not an epic)
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

  const { publicChildrenHidden } = (body ?? {}) as Record<string, unknown>;
  if (typeof publicChildrenHidden !== 'boolean') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`publicChildrenHidden` must be a boolean.' },
      { status: 400 },
    );
  }

  try {
    const item = await workItemsService.setEpicPrivacy(id, publicChildrenHidden, ctx);
    return NextResponse.json(item);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof NotProjectAdminError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof NotEpicError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
