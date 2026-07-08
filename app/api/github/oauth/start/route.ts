import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getSession } from '@/lib/auth';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { GithubOAuthNotConfiguredError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';

// GET /api/github/oauth/start (Story 7.10 · MOTIR-1498) — step 1 of the GitHub
// user-identity grant. The signed-in member is redirected to GitHub's authorize
// screen; we mint a CSRF `state` nonce, stash it in an httpOnly cookie, and put
// the same value in the authorize URL so the callback can prove the round-trip
// came back to the same browser.
//
// Routes are HTTP-only (CLAUDE.md): read the session, call the service, redirect.
// The service owns config resolution + the URL shape.

export const GITHUB_OAUTH_STATE_COOKIE = 'github_oauth_state';
const SETTINGS_PATH = '/settings/workspace/github';

export async function GET(_req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const state = randomBytes(32).toString('base64url');

  let authorizeUrl: string;
  try {
    authorizeUrl = githubIdentityService.buildAuthorizeUrl(state);
  } catch (err) {
    if (err instanceof GithubOAuthNotConfiguredError) {
      return NextResponse.redirect(
        `${resolveBaseUrlTrimmed()}${SETTINGS_PATH}?github=not_configured`,
      );
    }
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  // `sameSite: 'lax'` so the cookie survives GitHub's top-level GET redirect
  // back to the callback (a strict cookie would be dropped and every callback
  // would read as a state mismatch).
  res.cookies.set(GITHUB_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/',
    maxAge: 600, // 10 minutes — the OAuth round-trip is near-immediate
  });
  return res;
}
