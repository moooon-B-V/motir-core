import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';

// The provider's REASON for a failed connect, carried from the callback to the
// Monitoring room (Story MOTIR-4926 · MOTIR-5260, corrected under MOTIR-5288).
//
// ⚠️ WHY A COOKIE, AND WHY NOT THE TWO OBVIOUS CARRIERS.
//
//   · A RESPONSE HEADER — what this used to be — does not arrive. The callback
//     answers with a redirect, and a browser following a redirect never exposes
//     that response's headers to the page it lands on. The reason was set, a
//     test read it off the route's own Response, and no person could ever have
//     seen it: the room's "Sentry says: …" banner had nothing to say.
//   · A QUERY PARAMETER would arrive, and would let anybody put any sentence on a
//     Motir page: `…/monitoring?monitor=error&reason=<anything>` rendered as
//     "Sentry says: <anything>" is content spoofing with Motir's name on it.
//
// An httpOnly cookie set by THIS server on the redirect does both halves: it
// survives the hop, and a crafted link cannot mint one. It is short-lived because
// it describes one attempt, and it is read only alongside `?monitor=error`.

export const MONITOR_CONNECT_RESULT_COOKIE = 'motir_monitor_result';

/** One attempt's worth of life: the redirect is immediate, so a minute is ample
 *  and a stale reason cannot resurface on a later visit. */
export const MONITOR_CONNECT_RESULT_TTL_SECONDS = 60;

/** The longest reason the room will render. The provider's string is shown
 *  verbatim, but a cookie is not a transport for an unbounded upstream body. */
export const MONITOR_CONNECT_REASON_MAX = 500;

export const encodeMonitorConnectResult = (reason: string): string =>
  Buffer.from(
    JSON.stringify({ reason: reason.slice(0, MONITOR_CONNECT_REASON_MAX) }),
    'utf8',
  ).toString('base64url');

/** The reason back, or `null` for anything absent or malformed. */
export function decodeMonitorConnectResult(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      reason?: unknown;
    };
    return typeof parsed.reason === 'string' && parsed.reason.length > 0
      ? parsed.reason.slice(0, MONITOR_CONNECT_REASON_MAX)
      : null;
  } catch {
    return null;
  }
}

/** The cookie options, in one place so the setter and a test agree. */
export const monitorConnectResultCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: shouldUseSecureCookies(),
  path: '/',
  maxAge: MONITOR_CONNECT_RESULT_TTL_SECONDS,
});
