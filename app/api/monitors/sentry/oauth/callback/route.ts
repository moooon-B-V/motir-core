import { NextResponse, type NextRequest } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  MONITOR_CONNECT_STATE_COOKIE,
  decodeMonitorConnectState,
} from '@/lib/monitors/connectState';
import {
  MONITOR_CONNECT_RESULT_COOKIE,
  encodeMonitorConnectResult,
  monitorConnectResultCookieOptions,
} from '@/lib/monitors/connectResult';
import { MonitorProviderCallError, UnknownMonitorProviderError } from '@/lib/monitors/errors';
import { resolveMonitorReturnPath } from '@/lib/monitors/returnSurface';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';

// GET /api/monitors/sentry/oauth/callback (Story MOTIR-4926 · MOTIR-5260) —
// step 2 of the monitor connect grant, at EXACTLY the path the provisioning card
// (MOTIR-5257) registers as the integration's redirect URL.
//
// The provider redirects back with `code` and `installationId`. This route
// verifies a live session, reads the httpOnly state cookie for the project the
// flow started on, checks any echoed state against the cookie's nonce, and hands
// the code to the service. Then it lands on the Monitoring room with a status the
// room renders as a banner.
//
// ⚠️ THE FOUR NON-HAPPY PATHS ARE EACH A NAMED STATUS AND NEVER A 500, because
// every one of them is a thing a person did rather than a fault:
//
//   · the customer DECLINED in the provider's UI            → `denied`, nothing stored
//   · the grant exchange failed                              → `error`, carrying the
//                                                              provider's own reason,
//                                                              nothing stored
//   · NO valid state cookie — an install begun from the
//     provider's own directory rather than from Motir        → `no_state`, and never a
//                                                              GUESSED project
//   · the echoed state does not match the cookie's nonce     → `state_error`, nothing stored
//
// Routes are HTTP-only (CLAUDE.md): the service owns the exchange, the
// encryption, the transaction and the typed errors this maps to statuses.

function landing(returnSurfaceId: string | null, status: string): string {
  return `${resolveBaseUrlTrimmed()}${resolveMonitorReturnPath(returnSurfaceId)}?monitor=${status}`;
}

function done(returnSurfaceId: string | null, status: string): NextResponse {
  const res = NextResponse.redirect(landing(returnSurfaceId, status));
  // The state is single-use — cleared on every terminal outcome, so a replayed
  // callback finds no cookie and is refused by the `no_state` arm.
  res.cookies.delete(MONITOR_CONNECT_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const params = req.nextUrl.searchParams;
  const state = decodeMonitorConnectState(
    req.cookies.get(MONITOR_CONNECT_STATE_COOKIE)?.value ?? null,
  );

  // An absent, unparseable or EXPIRED cookie is one answer: this callback is not
  // completing a flow we can account for. It lands on the room with an
  // explanation rather than 500ing, and — the important half — it does NOT guess
  // a project.
  if (!state) return done(null, 'no_state');

  if (params.get('error')) return done(state.returnSurfaceId, 'denied');

  const echoed = params.get('state');
  // Checked only when present: the gate is the cookie, and the echo is a
  // documented expectation about the provider (see `connectState.ts`). A
  // MISMATCH is always a refusal.
  if (echoed !== null && echoed !== state.nonce) return done(state.returnSurfaceId, 'state_error');

  const code = params.get('code');
  const providerInstallationId = params.get('installationId');
  if (!code || !providerInstallationId) return done(state.returnSurfaceId, 'state_error');

  try {
    await monitorConnectionService.completeGrant(
      { provider: 'sentry', providerInstallationId, code, projectId: state.projectId },
      ctx,
    );
    return done(state.returnSurfaceId, 'connected');
  } catch (err) {
    if (err instanceof MonitorProviderCallError) {
      // The provider's OWN reason reaches the room, which is what makes a failed
      // connect actionable rather than "something went wrong".
      // Carried in a short-lived httpOnly cookie, never a header (a redirect's
      // headers never reach the page) and never the URL (a crafted link could
      // make "Sentry says" say anything) — `lib/monitors/connectResult.ts`.
      const res = done(state.returnSurfaceId, 'error');
      res.cookies.set(
        MONITOR_CONNECT_RESULT_COOKIE,
        encodeMonitorConnectResult(err.providerReason),
        monitorConnectResultCookieOptions(),
      );
      return res;
    }
    if (err instanceof UnknownMonitorProviderError) return done(state.returnSurfaceId, 'error');
    throw err;
  }
}
