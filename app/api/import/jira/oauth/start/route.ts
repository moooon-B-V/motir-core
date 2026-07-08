import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { resolveWorkspaceContext } from '@/lib/workspaces/middleware';
import { jiraOAuthService } from '@/lib/services/jiraOAuthService';
import { JiraOAuthNotConfiguredError } from '@/lib/import/jira/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// GET /api/import/jira/oauth/start (Story 7.16 · MOTIR-1654) — step 1 of the
// Jira 3LO connect flow the import wizard uses. The signed-in member is
// redirected to Atlassian's authorize screen; we mint a CSRF `state` nonce AND
// a PKCE `code_verifier`, stash both in httpOnly cookies, and put `state` +
// the verifier's S256 challenge in the authorize URL so the callback can prove
// the round-trip came back to the same browser and complete PKCE.
//
// Routes are HTTP-only (CLAUDE.md): resolve the member/workspace, call the
// service for the URL shape, set the cookies, redirect.

export const JIRA_OAUTH_STATE_COOKIE = 'jira_oauth_state';
export const JIRA_OAUTH_VERIFIER_COOKIE = 'jira_oauth_verifier';
export const IMPORT_PATH = '/onboarding/import';

const COOKIE_BASE = {
  httpOnly: true,
  // `lax` so the cookies survive Atlassian's top-level GET redirect back to the
  // callback (a strict cookie would be dropped and every callback would read as
  // a state / PKCE mismatch).
  sameSite: 'lax',
  secure: process.env['NODE_ENV'] === 'production',
  path: '/',
  maxAge: 600, // 10 minutes — the OAuth round-trip is near-immediate
} as const;

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await resolveWorkspaceContext(req);
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');

  let authorizeUrl: string;
  try {
    authorizeUrl = jiraOAuthService.buildAuthorizeUrl(state, codeVerifier);
  } catch (err) {
    if (err instanceof JiraOAuthNotConfiguredError) {
      return NextResponse.redirect(`${resolveBaseUrlTrimmed()}${IMPORT_PATH}?jira=not_configured`);
    }
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(JIRA_OAUTH_STATE_COOKIE, state, COOKIE_BASE);
  res.cookies.set(JIRA_OAUTH_VERIFIER_COOKIE, codeVerifier, COOKIE_BASE);
  return res;
}
