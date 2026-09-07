import { NextResponse, type NextRequest } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { GithubOAuthExchangeError, GithubOAuthNotConfiguredError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { resolveReturnPath } from '@/lib/github/returnSurface';
import { GITHUB_OAUTH_STATE_COOKIE } from '../start/route';

// GET /api/github/oauth/callback (Story 7.10 · MOTIR-1498) — step 2 of the
// user-identity grant. GitHub redirects the member back with `code` + `state`.
// The identity binds to the SIGNED-IN member, so this route requires a session
// (unlike the token-capability email-confirm link). We verify the CSRF state
// against the cookie, hand the code to the service, and redirect back to the
// GitHub settings surface with a status the UI renders as a banner.
//
// Routes are HTTP-only (CLAUDE.md): the service owns the exchange, encryption,
// the transaction, and the typed errors this maps to redirect statuses.

// THE COOKIE CARRIES TWO THINGS (MOTIR-4676): `<nonce>.<originId>`, or a bare
// nonce when the flow started from the default surface — or when the cookie was
// written by a build that predates this change. Splitting on the FIRST dot is
// safe because `randomBytes(32).toString('base64url')` contains none, and the
// origin half is a key of `GITHUB_RETURN_SURFACES` rather than a path.
function splitStateCookie(raw: string | null): { nonce: string | null; origin: string | null } {
  if (!raw) return { nonce: null, origin: null };
  const dot = raw.indexOf('.');
  if (dot < 0) return { nonce: raw, origin: null };
  return { nonce: raw.slice(0, dot), origin: raw.slice(dot + 1) };
}

/** Redirect back to the surface the flow STARTED from, with its banner status.
 *  An absent or unrecognised origin resolves to the historical settings path,
 *  so nothing about an in-flight round trip changes. */
function returnRedirect(status: string, origin: string | null): NextResponse {
  const res = NextResponse.redirect(
    `${resolveBaseUrlTrimmed()}${resolveReturnPath(origin)}?github=${status}`,
  );
  // The state nonce is single-use — clear it on every terminal outcome.
  res.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const params = req.nextUrl.searchParams;

  // Read the origin BEFORE any early return, so every outcome — including the
  // declined and state-mismatch ones — lands the person where they started.
  // Being sent to a settings page you never opened is exactly as disorienting
  // when the flow failed as when it succeeded.
  const { nonce, origin } = splitStateCookie(
    req.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value ?? null,
  );

  // GitHub bounces back with ?error=access_denied when the member declines.
  if (params.get('error')) return returnRedirect('denied', origin);

  const code = params.get('code');
  const state = params.get('state');
  // ⚠️ The CSRF comparison is against the NONCE half, not the whole cookie:
  // GitHub echoes the bare nonce we put in the authorize URL. The property is
  // unchanged — a cookie set by this browser still has to match — and a bare
  // pre-MOTIR-4676 cookie splits to itself, so an in-flight round trip that
  // started before the deploy still verifies.
  if (!code || !state || !nonce || state !== nonce) {
    return returnRedirect('state_error', origin);
  }

  try {
    await githubIdentityService.completeOAuthCallback({ code, userId: session.user.id });
    return returnRedirect('connected', origin);
  } catch (err) {
    if (err instanceof GithubOAuthNotConfiguredError)
      return returnRedirect('not_configured', origin);
    if (err instanceof GithubOAuthExchangeError) return returnRedirect('error', origin);
    throw err;
  }
}
