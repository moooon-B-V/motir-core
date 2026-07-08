import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { resolveWorkspaceContext } from '@/lib/workspaces/middleware';
import { planeImportOAuthService } from '@/lib/services/planeImportOAuthService';
import { PlaneInvalidBaseUrlError, PlaneOAuthNotConfiguredError } from '@/lib/import/plane/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// GET /api/import/plane/oauth/start (Story 7.16 · MOTIR-1656) — step 1 of the
// Plane "Connect" grant the import wizard uses. The signed-in member is
// redirected to Plane's authorize screen; we mint a CSRF `state` nonce, stash it
// in an httpOnly cookie, and put the same value in the authorize URL so the
// callback can prove the round-trip came back to the same browser.
//
// Plane's OAuth host is PER-INSTANCE, so the connect form supplies the instance
// base URL up front (`?baseUrl=`, default Plane Cloud) — and, optionally, the
// Plane workspace slug (`?workspaceSlug=`). Both are stashed in httpOnly cookies
// so the callback runs the token exchange against the SAME instance and can
// persist the slug (plain-valued cookies, not JSON — a URL / slug is a safe
// cookie-octet string; JSON's quotes/commas are not). The identity is
// workspace-scoped, so we resolve the active workspace here — a member with no
// workspace context can't reach the flow. Routes are HTTP-only (CLAUDE.md): read
// context + input, call the service, redirect.

export const PLANE_OAUTH_STATE_COOKIE = 'plane_import_oauth_state';
export const PLANE_OAUTH_BASE_COOKIE = 'plane_import_oauth_base';
export const PLANE_OAUTH_SLUG_COOKIE = 'plane_import_oauth_slug';
export const IMPORT_PATH = '/onboarding/import';

const COOKIE_BASE = {
  httpOnly: true,
  // `lax` so the cookies survive Plane's top-level GET redirect back to the
  // callback (a strict cookie would be dropped and every callback would read as
  // a state mismatch).
  sameSite: 'lax',
  secure: process.env['NODE_ENV'] === 'production',
  path: '/',
  maxAge: 600, // 10 minutes — the OAuth round-trip is near-immediate
} as const;

function importRedirect(status: string): NextResponse {
  return NextResponse.redirect(`${resolveBaseUrlTrimmed()}${IMPORT_PATH}?import=${status}`);
}

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await resolveWorkspaceContext(req);
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const baseUrl = params.get('baseUrl');
  const workspaceSlug = params.get('workspaceSlug');
  const state = randomBytes(32).toString('base64url');

  let authorizeUrl: string;
  try {
    authorizeUrl = planeImportOAuthService.buildAuthorizeUrl({ state, baseUrl });
  } catch (err) {
    if (err instanceof PlaneInvalidBaseUrlError) return importRedirect('plane_invalid_url');
    if (err instanceof PlaneOAuthNotConfiguredError) return importRedirect('plane_not_configured');
    throw err;
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(PLANE_OAUTH_STATE_COOKIE, state, COOKIE_BASE);
  // The connect context (which instance + slug) must survive the round-trip: the
  // callback exchanges the code against the SAME host and persists the slug.
  // Only set what was supplied — an absent cookie reads as "use the default".
  if (baseUrl) res.cookies.set(PLANE_OAUTH_BASE_COOKIE, baseUrl, COOKIE_BASE);
  if (workspaceSlug) res.cookies.set(PLANE_OAUTH_SLUG_COOKIE, workspaceSlug, COOKIE_BASE);
  return res;
}
