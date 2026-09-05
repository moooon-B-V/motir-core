import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { GithubOAuthNotConfiguredError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import {
  DEFAULT_RETURN_PATH,
  GITHUB_RETURN_SURFACES,
  parseReturnSurfaceId,
} from '@/lib/github/returnSurface';

// GET /api/github/oauth/start (Story 7.10 · MOTIR-1498) — step 1 of the GitHub
// user-identity grant. The signed-in member is redirected to GitHub's authorize
// screen; we mint a CSRF `state` nonce, stash it in an httpOnly cookie, and put
// the same value in the authorize URL so the callback can prove the round-trip
// came back to the same browser.
//
// Routes are HTTP-only (CLAUDE.md): read the session, call the service, redirect.
// The service owns config resolution + the URL shape.

export const GITHUB_OAUTH_STATE_COOKIE = 'github_oauth_state';

// WHERE THE FLOW RETURNS TO (MOTIR-4676). The caller names its surface with
// `?from=<id>`; the id is narrowed against `GITHUB_RETURN_SURFACES` HERE, at the
// only moment it is attacker-influenced, and what is stored is the narrowed id.
//
// ⚠️ The origin then rides in OUR OWN httpOnly cookie beside the CSRF nonce and
// NEVER TRAVELS TO GITHUB. That is deliberate and it is stronger than signing
// it: a value that does not take the round trip cannot be tampered with on the
// round trip. (The App-INSTALL flow has no such option — it starts from a bare
// github.com URL where no cookie can be set — so there the origin rides inside
// the signed install-state envelope instead. `returnSurface.ts` records both.)
//
// The cookie holds `<nonce>.<originId>`; the `state` GitHub echoes is the bare
// nonce, exactly as before. So the CSRF property is untouched — the callback
// still compares GitHub's `state` with the nonce half — and a cookie written by
// the OLD build (a bare nonce, no dot) still compares equal and simply yields no
// origin.
const RETURN_PARAM = 'from';

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const nonce = randomBytes(32).toString('base64url');
  const origin = parseReturnSurfaceId(req.nextUrl.searchParams.get(RETURN_PARAM));

  let authorizeUrl: string;
  try {
    authorizeUrl = githubIdentityService.buildAuthorizeUrl(nonce);
  } catch (err) {
    if (err instanceof GithubOAuthNotConfiguredError) {
      // The not-configured bounce goes to the surface the person STARTED from,
      // for the same reason every other outcome does: they are standing there.
      return NextResponse.redirect(
        `${resolveBaseUrlTrimmed()}${origin ? GITHUB_RETURN_SURFACES[origin] : DEFAULT_RETURN_PATH}?github=not_configured`,
      );
    }
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  // `sameSite: 'lax'` so the cookie survives GitHub's top-level GET redirect
  // back to the callback (a strict cookie would be dropped and every callback
  // would read as a state mismatch).
  res.cookies.set(GITHUB_OAUTH_STATE_COOKIE, origin ? `${nonce}.${origin}` : nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/',
    maxAge: 600, // 10 minutes — the OAuth round-trip is near-immediate
  });
  return res;
}
