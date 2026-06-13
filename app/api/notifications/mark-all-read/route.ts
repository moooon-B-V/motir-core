import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { notificationsService } from '@/lib/services/notificationsService';

// POST /api/notifications/mark-all-read (Story 5.7 · Subtask 5.7.4) — mark ALL
// of the caller's unread notifications read in ONE bulk operation (the drawer
// overflow's "Mark all as read"; the 5.7.2 bulk updateMany, NOT a per-row
// client loop — the JRACLOUD-85017 anti-pattern). Thin HTTP layer; no db here.
//
// POST → MarkAllReadResultDTO { unreadCount: 0 }  (the caller clears the badge
//   from this response — the inline-edit contract)

export async function POST(): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const result = await notificationsService.markAllRead(ctx);
  return NextResponse.json(result);
}
