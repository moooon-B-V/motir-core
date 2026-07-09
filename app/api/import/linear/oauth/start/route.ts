import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getWorkspaceContext } from '@/lib/workspaces';
import { linearImportOAuthService } from '@/lib/services/linearImportOAuthService';
import { LinearOAuthNotConfiguredError } from '@/lib/import/linear/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  IMPORT_OAUTH_RETURN_COOKIE,
  appendStatus,
  safeImportReturnPath,
} from '@/lib/import/oauthReturn';

// GET /api/import/linear/oauth/start (Story 7.16 · MOTIR-1655) — step 1 of the
// Linear "Connect" grant for the issue importer. The signed-in member is
// redirected to Linear's authorize screen; we mint a CSRF `state` nonce, stash
// it in an httpOnly cookie, and put the same value in the authorize URL so the
// callback can prove the round-trip came back to the same browser.
//
// The identity is workspace-scoped (the substrate keys on [user, source,
// workspace]), so we resolve the active workspace here — a member with no
// workspace context can't reach the flow. Routes are HTTP-only (CLAUDE.md): read
// the context, call the service, redirect. The service owns config + URL shape.

export const LINEAR_OAUTH_STATE_COOKIE = 'linear_import_oauth_state';

export async function GET(req: NextRequest): Promise<Response> {
  // getWorkspaceContext returns null only when there is no session, so it doubles
  // as the auth gate — an unauthenticated caller gets a 401, not a redirect.
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  // The wizard door to return to after the round-trip, open-redirect-validated.
  const returnTo = safeImportReturnPath(req.nextUrl.searchParams.get('returnTo'));

  const state = randomBytes(32).toString('base64url');

  let authorizeUrl: string;
  try {
    authorizeUrl = linearImportOAuthService.buildAuthorizeUrl(state);
  } catch (err) {
    if (err instanceof LinearOAuthNotConfiguredError) {
      return NextResponse.redirect(
        `${resolveBaseUrlTrimmed()}${appendStatus(returnTo, 'import', 'linear_not_configured')}`,
      );
    }
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(IMPORT_OAUTH_RETURN_COOKIE, returnTo, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: 600,
  });
  // `sameSite: 'lax'` so the cookie survives Linear's top-level GET redirect back
  // to the callback (a strict cookie would be dropped and every callback would
  // read as a state mismatch).
  res.cookies.set(LINEAR_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: 600, // 10 minutes — the OAuth round-trip is near-immediate
  });
  return res;
}
