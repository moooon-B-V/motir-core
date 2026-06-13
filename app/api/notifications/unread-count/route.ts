import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { notificationsService } from '@/lib/services/notificationsService';

// GET /api/notifications/unread-count (Story 5.7 · Subtask 5.7.4) — the cheap
// unread aggregate the bell badge polls (the 5.7.2 partial-index count) for the
// active workspace + caller. Thin HTTP layer; no db here (CLAUDE.md).
//
// GET → { unreadCount: number }

export async function GET(): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const result = await notificationsService.getUnreadCount(ctx);
  return NextResponse.json(result);
}
