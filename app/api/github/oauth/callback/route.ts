import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { GithubOAuthExchangeError, GithubOAuthNotConfiguredError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
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

const SETTINGS_PATH = '/settings/workspace/github';

function settingsRedirect(status: string): NextResponse {
  const res = NextResponse.redirect(`${resolveBaseUrlTrimmed()}${SETTINGS_PATH}?github=${status}`);
  // The state nonce is single-use — clear it on every terminal outcome.
  res.cookies.delete(GITHUB_OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const params = req.nextUrl.searchParams;

  // GitHub bounces back with ?error=access_denied when the member declines.
  if (params.get('error')) return settingsRedirect('denied');

  const code = params.get('code');
  const state = params.get('state');
  const cookieState = req.cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value ?? null;
  if (!code || !state || !cookieState || state !== cookieState) {
    return settingsRedirect('state_error');
  }

  try {
    await githubIdentityService.completeOAuthCallback({ code, userId: session.user.id });
    return settingsRedirect('connected');
  } catch (err) {
    if (err instanceof GithubOAuthNotConfiguredError) return settingsRedirect('not_configured');
    if (err instanceof GithubOAuthExchangeError) return settingsRedirect('error');
    throw err;
  }
}
