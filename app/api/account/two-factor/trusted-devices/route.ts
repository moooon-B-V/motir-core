import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { twoFactorService } from '@/lib/services/twoFactorService';

// DELETE /api/account/two-factor/trusted-devices (Story 8.11 · Subtask
// MOTIR-1221) — revoke the browsers the reader told Motir to stop asking, so
// the next sign-in on them is challenged again. One id, or all of them.
//
// The story's acceptance criterion is the pair: "remember this device"
// suppresses the next challenge, and "clearing/revoking trusted devices restores
// it". The plugin owns the first half (a `trustDevice` flag on the verify call);
// this route is the second, because the plugin ships no revoke.
//
// ⚠️ THERE IS NO GET ARM. The pane reads its list server-side in
// `settings/account/security/page.tsx`, so a JSON read would be a second door
// onto the same rows with its own auth to keep correct. The island refetches by
// refreshing the row set it already holds.
//
// Personal and session-scoped, so the gate is `getSession`. The user id comes
// from the SESSION and is never accepted from the body — the ownership check
// that makes this safe is `value = <that id>` inside the repository, and a body
// -supplied id would defeat it entirely.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → status.

export async function DELETE(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is the "revoke all" call — not a malformed request.
  }
  const id = (body as { id?: unknown } | null)?.id;

  if (id === undefined || id === null) {
    const revoked = await twoFactorService.revokeAllTrustedDevices(session.user.id);
    return NextResponse.json({ revoked });
  }
  if (typeof id !== 'string' || id.trim() === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`id` must be a non-empty string.' },
      { status: 400 },
    );
  }

  const revoked = await twoFactorService.revokeTrustedDevice(session.user.id, id);
  // 404, not 403: the row either is not this user's or does not exist, and
  // telling those apart would confirm the existence of somebody else's grant.
  if (!revoked) return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ revoked: 1 });
}
