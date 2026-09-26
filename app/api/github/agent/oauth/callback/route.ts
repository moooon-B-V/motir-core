import { NextResponse, type NextRequest } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { githubAgentAuthService } from '@/lib/services/githubAgentAuthService';
import { GithubAgentAppNotConfiguredError, GithubOAuthExchangeError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { GITHUB_RETURN_SURFACES, parseReturnSurfaceId } from '@/lib/github/returnSurface';
import { GITHUB_AGENT_DEFAULT_RETURN, GITHUB_AGENT_OAUTH_STATE_COOKIE } from '../start/route';

// GET /api/github/agent/oauth/callback (Story MOTIR-683 · MOTIR-6519) — step 2
// of the Motir Agent link, and the redirect URI registered on the App
// (MOTIR-1894). GitHub also lands a person here straight after INSTALLING the
// App, because the App requests user authorization during installation; that
// arrival carries `installation_id` / `setup_action` and no state cookie we set,
// and is handled the same way as any other code: a state mismatch is refused.
// The service owns the exchange, the encryption and the transaction.

function splitStateCookie(raw: string | null): { nonce: string | null; origin: string | null } {
  if (!raw) return { nonce: null, origin: null };
  const dot = raw.indexOf('.');
  if (dot < 0) return { nonce: raw, origin: null };
  return { nonce: raw.slice(0, dot), origin: raw.slice(dot + 1) };
}

function returnRedirect(status: string, origin: string | null): NextResponse {
  const id = parseReturnSurfaceId(origin);
  const path = id ? GITHUB_RETURN_SURFACES[id] : GITHUB_AGENT_DEFAULT_RETURN;
  const res = NextResponse.redirect(`${resolveBaseUrlTrimmed()}${path}?githubAgent=${status}`);
  res.cookies.delete(GITHUB_AGENT_OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const params = req.nextUrl.searchParams;
  const { nonce, origin } = splitStateCookie(
    req.cookies.get(GITHUB_AGENT_OAUTH_STATE_COOKIE)?.value ?? null,
  );

  if (params.get('error')) return returnRedirect('denied', origin);

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state || !nonce || state !== nonce) {
    return returnRedirect('state_error', origin);
  }

  try {
    await githubAgentAuthService.completeOAuthCallback({ code, userId: session.user.id });
    return returnRedirect('linked', origin);
  } catch (err) {
    if (err instanceof GithubAgentAppNotConfiguredError)
      return returnRedirect('not_configured', origin);
    if (err instanceof GithubOAuthExchangeError) return returnRedirect('error', origin);
    throw err;
  }
}
