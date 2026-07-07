import { NextResponse, type NextRequest } from 'next/server';
import { resolveWorkspaceContext } from '@/lib/workspaces/middleware';
import { jiraOAuthService } from '@/lib/services/jiraOAuthService';
import { JiraOAuthExchangeError, JiraOAuthNotConfiguredError } from '@/lib/import/jira/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { IMPORT_PATH, JIRA_OAUTH_STATE_COOKIE, JIRA_OAUTH_VERIFIER_COOKIE } from '../start/route';

// GET /api/import/jira/oauth/callback (Story 7.16 · MOTIR-1654) — step 2 of the
// Jira 3LO connect flow. Atlassian redirects the member back with `code` +
// `state`. The identity binds to the SIGNED-IN member in their active
// workspace, so this route requires a workspace context. We verify the CSRF
// state against the cookie, replay the stashed PKCE verifier, hand both to the
// service, and redirect back to the import wizard with a status the UI renders
// as a banner.
//
// Routes are HTTP-only (CLAUDE.md): the service owns the exchange, the
// accessible-resources read, encryption, the transaction, and the typed errors
// this maps to redirect statuses.

function importRedirect(status: string): NextResponse {
  const res = NextResponse.redirect(`${resolveBaseUrlTrimmed()}${IMPORT_PATH}?jira=${status}`);
  // The state nonce + PKCE verifier are single-use — clear them on every
  // terminal outcome.
  res.cookies.delete(JIRA_OAUTH_STATE_COOKIE);
  res.cookies.delete(JIRA_OAUTH_VERIFIER_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await resolveWorkspaceContext(req);
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const params = req.nextUrl.searchParams;

  // Atlassian bounces back with ?error=access_denied when the member declines.
  if (params.get('error')) return importRedirect('denied');

  const code = params.get('code');
  const state = params.get('state');
  const cookieState = req.cookies.get(JIRA_OAUTH_STATE_COOKIE)?.value ?? null;
  const codeVerifier = req.cookies.get(JIRA_OAUTH_VERIFIER_COOKIE)?.value ?? null;
  if (!code || !state || !cookieState || state !== cookieState || !codeVerifier) {
    return importRedirect('state_error');
  }

  try {
    await jiraOAuthService.completeOAuthCallback({
      code,
      codeVerifier,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return importRedirect('connected');
  } catch (err) {
    if (err instanceof JiraOAuthNotConfiguredError) return importRedirect('not_configured');
    if (err instanceof JiraOAuthExchangeError) return importRedirect('error');
    throw err;
  }
}
