import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { notificationsService } from '@/lib/services/notificationsService';
import { NotificationNotFoundError } from '@/lib/notifications/errors';

// PATCH /api/notifications/[id]/read (Story 5.7 · Subtask 5.7.4) — mark ONE
// notification the caller owns read. Thin HTTP layer over notificationsService;
// no db / no transaction here (CLAUDE.md).
//
// PATCH → MarkReadResultDTO { notification, unreadCount }  (the caller updates
//   the badge + row from this response — the inline-edit contract, no re-fetch)
//
// Typed error → status (finding #44 — a row that's missing, owned by another
// user, or in another workspace all read as 404, never "exists but forbidden"):
//   NotificationNotFoundError → 404

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const result = await notificationsService.markRead(id, ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NotificationNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
