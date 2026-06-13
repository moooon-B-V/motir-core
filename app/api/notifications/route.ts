import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { notificationsService } from '@/lib/services/notificationsService';

// GET /api/notifications (Story 5.7 · Subtask 5.7.4) — one cursor-paged window
// of the caller's notification feed for the active workspace. Thin HTTP layer
// over notificationsService; no db / no transaction here (CLAUDE.md).
//
// GET ?cursor=<notificationId>&category=direct|watching → one NotificationsPageDTO
//
// The feed is scoped to the session user by the service; there is no per-row
// permission branch (a notification belongs to its recipient), so the only
// failure mode is 401 (no session).

export async function GET(req: Request): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const categoryParam = url.searchParams.get('category');
  if (categoryParam !== null && categoryParam !== 'direct' && categoryParam !== 'watching') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`category` must be "direct" or "watching".' },
      { status: 400 },
    );
  }

  const page = await notificationsService.listNotifications(
    { cursor, category: categoryParam ?? undefined },
    ctx,
  );
  return NextResponse.json(page);
}
