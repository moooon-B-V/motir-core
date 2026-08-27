import { NextResponse } from 'next/server';
import { notificationsService } from '@/lib/services/notificationsService';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/notifications/unread-count (Story 5.7 · Subtask 5.7.4) — the cheap
// unread aggregate the bell badge polls (the 5.7.2 partial-index count) for the
// active workspace + caller. Thin HTTP layer; no db here (CLAUDE.md).
//
// GET → { unreadCount: number }

export async function GET(): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const result = await notificationsService.getUnreadCount(ctx);
  return NextResponse.json(result);
}
