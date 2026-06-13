import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { mapNotificationPreferenceError } from '@/lib/notifications/preferenceErrorResponse';

// /api/notification-preferences (Story 5.7 · Subtask 5.7.6) — the CURRENT
// user's per-event-type × channel notification preferences. Personal settings,
// scoped to the session user only (no workspace context — they apply across
// every workspace), so the gate is `getSession`, not `getWorkspaceContext`.
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.
//
// GET → 200 { matrix: NotificationPreferenceMatrixDto }
// PUT { eventType, channel, enabled } → 200 { cell: NotificationPreferenceCellDto }
//   — toggle one cell; the response carries the resolved cell so the client
//   updates from it (no tree re-fetch — the inline-edit-no-whole-tree-refresh
//   contract).

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const matrix = await notificationPreferencesService.getMatrix(session.user.id);
  return NextResponse.json({ matrix });
}

export async function PUT(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { eventType, channel, enabled, ...rest } = (body ?? {}) as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: `Unknown field: ${Object.keys(rest)[0]}.` },
      { status: 400 },
    );
  }
  if (typeof eventType !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`eventType` must be a string.' },
      { status: 400 },
    );
  }
  if (typeof channel !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`channel` must be a string.' },
      { status: 400 },
    );
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`enabled` must be a boolean.' },
      { status: 400 },
    );
  }

  try {
    const cell = await notificationPreferencesService.setPreference(session.user.id, {
      eventType,
      channel,
      enabled,
    });
    return NextResponse.json({ cell });
  } catch (err) {
    const mapped = mapNotificationPreferenceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
