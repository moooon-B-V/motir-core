import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { TwoFactorNotEnabledError } from '@/lib/twoFactor/errors';

// POST /api/account/two-factor/backup-codes (Story MOTIR-1213 · Subtask
// MOTIR-1218) — mint a fresh recovery-code set for the signed-in user,
// replacing whatever is there.
//
// ⚠️ THE RESPONSE IS THE ONLY TIME THE PLAINTEXT EXISTS. The stored form is
// encrypted and the status route can only ever answer a count, so a client that
// drops this body has lost the codes for good and must regenerate again. The
// pane shows them once with a download, exactly as the story's recipe says.
//
// POST, not GET, for the same reason: this MUTATES (it invalidates every
// previously issued code), so it must not be reachable by a prefetch, a
// link-preview fetch, or a browser history replay.
//
// Personal and session-scoped, so the gate is `getSession`. The step-up
// re-check that guards every 2FA management action belongs to the pane
// (MOTIR-1220), which prompts before it calls this.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error →
// status. There is no body to parse; the user comes from the session.

export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  try {
    return NextResponse.json(await twoFactorService.regenerateBackupCodes(session.user.id));
  } catch (err) {
    // Nothing to regenerate — the account has no enrolment. 409, not 404: the
    // route exists and the user exists; the account's STATE is what refuses.
    if (err instanceof TwoFactorNotEnabledError)
      return NextResponse.json({ code: err.code }, { status: 409 });
    throw err;
  }
}
