import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getWorkspaceContext } from '@/lib/workspaces';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { encodeOAuthState } from '@/lib/gitlab/oauthState';
import { GitlabOAuthNotConfiguredError } from '@/lib/gitlab/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';

// GET /api/gitlab/oauth/start (Story 7.23 · MOTIR-1474) — step 1 of the GitLab
// connect grant. Unlike GitHub's user-scoped identity, a GitLab connection is
// WORKSPACE-scoped, so we resolve the acting member's active workspace and carry
// it (signed) through the round-trip. We mint a nonce, stash it in an httpOnly
// cookie, and sign `{ workspace, user, nonce }` into the `state` GitLab echoes
// back, so the callback binds the connection to the SAME workspace + browser.
//
// Routes are HTTP-only (CLAUDE.md): read the session, resolve the workspace, call
// the service, redirect. The service owns config resolution + the URL shape.

export const GITLAB_OAUTH_NONCE_COOKIE = 'gitlab_oauth_nonce';
// ⚠️ THE SURFACE MOVED A TIER (Story MOTIR-4669 · MOTIR-4680). It was
// `/settings/workspace/gitlab`, which is deleted and permanently redirects here;
// the provider travels as a SEARCH PARAM because the repository inventory on this
// page spans both hosts. Redirecting to the live path rather than through the
// redirect keeps the banner's query string on one hop — and a constant that names
// a route the app no longer serves cannot be read as deliberate.
const SETTINGS_PATH = '/settings/organization/git?provider=gitlab';

export async function GET(_req: NextRequest): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.redirect(`${resolveBaseUrlTrimmed()}${SETTINGS_PATH}&gitlab=no_workspace`);
  }

  const nonce = randomBytes(32).toString('base64url');
  const state = encodeOAuthState({ workspaceId: ctx.workspaceId, userId: ctx.userId, nonce });

  let authorizeUrl: string;
  try {
    authorizeUrl = gitlabConnectionService.buildAuthorizeUrl(state);
  } catch (err) {
    if (err instanceof GitlabOAuthNotConfiguredError) {
      return NextResponse.redirect(
        `${resolveBaseUrlTrimmed()}${SETTINGS_PATH}&gitlab=not_configured`,
      );
    }
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  // `sameSite: 'lax'` so the cookie survives GitLab's top-level GET redirect back
  // to the callback (a strict cookie would be dropped and every callback would
  // read as a state mismatch).
  res.cookies.set(GITLAB_OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/',
    maxAge: 600, // 10 minutes — the OAuth round-trip is near-immediate
  });
  return res;
}
