import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { githubAgentAuthService } from '@/lib/services/githubAgentAuthService';
import { GithubAgentAppNotConfiguredError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { GITHUB_RETURN_SURFACES, parseReturnSurfaceId } from '@/lib/github/returnSurface';

// GET /api/github/agent/oauth/start (Story MOTIR-683 · MOTIR-6519) — step 1 of
// linking a member's GitHub account to the MOTIR AGENT app, so a hosted run on a
// repository they own is authored as them (`hosted-agent-run.md` §4). The same
// shape as `/api/github/oauth/start` (MOTIR-1498): a CSRF nonce in an httpOnly
// cookie beside the narrowed return-surface id, and the bare nonce as `state`.
// Its own cookie name, so a Motir Integration round trip in another tab cannot
// satisfy this one.

export const GITHUB_AGENT_OAUTH_STATE_COOKIE = 'github_agent_oauth_state';

/** Where a link flow lands when it carries no origin: the member's own Git
 *  accounts page, which is where the Motir Agent row lives. */
export const GITHUB_AGENT_DEFAULT_RETURN = GITHUB_RETURN_SURFACES.accountGit;

const RETURN_PARAM = 'from';

export async function GET(req: NextRequest): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const nonce = randomBytes(32).toString('base64url');
  const origin = parseReturnSurfaceId(req.nextUrl.searchParams.get(RETURN_PARAM));

  let authorizeUrl: string;
  try {
    authorizeUrl = githubAgentAuthService.buildAuthorizeUrl(nonce);
  } catch (err) {
    if (err instanceof GithubAgentAppNotConfiguredError) {
      return NextResponse.redirect(
        `${resolveBaseUrlTrimmed()}${origin ? GITHUB_RETURN_SURFACES[origin] : GITHUB_AGENT_DEFAULT_RETURN}?githubAgent=not_configured`,
      );
    }
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(GITHUB_AGENT_OAUTH_STATE_COOKIE, origin ? `${nonce}.${origin}` : nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/',
    maxAge: 600,
  });
  return res;
}
