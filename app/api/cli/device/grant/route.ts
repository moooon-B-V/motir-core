import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { cliDeviceService } from '@/lib/services/cliDeviceService';
import {
  DeviceGrantExpiredError,
  DeviceGrantForbiddenError,
  DeviceGrantNotClaimedError,
  InvalidDeviceGrantError,
} from '@/lib/cliDevice/errors';

// GET /api/cli/device/grant?user_code=… (Story MOTIR-1863 · Subtask MOTIR-1888) — what
// the /device approval screen (MOTIR-1867) reads to answer "WHAT is connecting". Called
// by the page on mount, never by the CLI.
//
// COOKIE-SESSION ONLY, the same security model as `approve` and for a stronger reason:
// this is a browser surface, so it is never bearer-reachable — a PAT cannot be used to
// enumerate in-flight grants, and the route reaches for `getSession()` alone, never the
// bearer gate in `lib/apiTokens/routeAuth.ts`.
//
// IT ALSO CLAIMS. A GET with a side effect is unusual, so it is worth stating why:
// Better-Auth's verify read IS the claim (it stamps `userId`), and approval refuses an
// unclaimed grant — so the page's mount read and the claim are the same act. See
// `cliDeviceService.describe` for why they are deliberately not split. `no-store`
// follows from that: the response describes a single-use credential-in-waiting whose
// status changes underneath it, and it must never be replayed from a proxy or the
// back/forward cache.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.

export async function GET(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  // `user_code` (snake_case) matches the query parameter the CLI already prints in
  // `verification_uri_complete`, so the page can forward what it was handed.
  const userCode = new URL(req.url).searchParams.get('user_code');
  if (userCode === null || userCode.trim().length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A user_code is required.' },
      { status: 400 },
    );
  }

  try {
    const grant = await cliDeviceService.describe({
      userCode,
      actorUserId: session.user.id,
      // Better-Auth's verify endpoint reads the session from the request itself, so the
      // cookies have to be forwarded — `getSession()` above gates the route, but it
      // cannot stand in for the plugin's own session read, and that read is what makes
      // the claim happen.
      headers: req.headers,
    });
    return NextResponse.json(grant, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // Claimed by a different signed-in user — the phishing-relevant case. Mirrors
    // `approve`'s 403 so the page handles one code, not two.
    if (err instanceof DeviceGrantForbiddenError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    if (err instanceof InvalidDeviceGrantError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    if (err instanceof DeviceGrantExpiredError) {
      return NextResponse.json({ code: err.code }, { status: 410 });
    }
    // The claim did not land (cookies not forwarded) — 409, the same code and status
    // `approve` answers for the same sequencing bug.
    if (err instanceof DeviceGrantNotClaimedError) {
      return NextResponse.json({ code: err.code }, { status: 409 });
    }
    throw err;
  }
}

// NOTE — `approved` and `denied` are 200s carrying that `status`, not errors. They are
// terminal SCREENS the page renders ("Connected", "Request denied"), and modelling them
// as failures would push the page into an error branch for two of its six normal states.
