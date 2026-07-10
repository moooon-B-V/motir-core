import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { GitlabOAuthExchangeError, GitlabOAuthNotConfiguredError } from '@/lib/gitlab/errors';
import { decodeOAuthState } from '@/lib/gitlab/oauthState';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { GITLAB_OAUTH_NONCE_COOKIE } from '../start/route';

// GET /api/gitlab/oauth/callback (Story 7.23 · MOTIR-1474) — step 2 of the connect
// grant. GitLab redirects back with `code` + `state`. The connection binds to the
// signed state's WORKSPACE (not the user), so this verifies: a live session, the
// state's signature/expiry, that the state's user == the acting session user, and
// that the state's nonce matches the httpOnly cookie (double-submit CSRF). Then it
// hands the code to the service and redirects to the GitLab settings surface with
// a status the UI renders as a banner. Actual membership is enforced by the
// service's `withWorkspaceContext` (RLS) write.
//
// Routes are HTTP-only (CLAUDE.md): the service owns the exchange, encryption, the
// transaction, and the typed errors this maps to redirect statuses.

const SETTINGS_PATH = '/settings/workspace/gitlab';

function settingsRedirect(status: string): NextResponse {
  const res = NextResponse.redirect(`${resolveBaseUrlTrimmed()}${SETTINGS_PATH}?gitlab=${status}`);
  // The nonce is single-use — clear it on every terminal outcome.
  res.cookies.delete(GITLAB_OAUTH_NONCE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const params = req.nextUrl.searchParams;

  // GitLab bounces back with ?error=access_denied when the member declines.
  if (params.get('error')) return settingsRedirect('denied');

  const code = params.get('code');
  const stateToken = params.get('state');
  const cookieNonce = req.cookies.get(GITLAB_OAUTH_NONCE_COOKIE)?.value ?? null;
  if (!code || !stateToken) return settingsRedirect('state_error');

  const decoded = decodeOAuthState(stateToken);
  if (
    !decoded ||
    decoded.userId !== session.user.id ||
    !cookieNonce ||
    decoded.nonce !== cookieNonce
  ) {
    return settingsRedirect('state_error');
  }

  try {
    await gitlabConnectionService.completeOAuthCallback({
      code,
      workspaceId: decoded.workspaceId,
      userId: session.user.id,
    });
    return settingsRedirect('connected');
  } catch (err) {
    if (err instanceof GitlabOAuthNotConfiguredError) return settingsRedirect('not_configured');
    if (err instanceof GitlabOAuthExchangeError) return settingsRedirect('error');
    throw err;
  }
}
