import { NextResponse, type NextRequest } from 'next/server';
import { resolveWorkspaceContext } from '@/lib/workspaces/middleware';
import { planeImportOAuthService } from '@/lib/services/planeImportOAuthService';
import {
  PlaneInvalidBaseUrlError,
  PlaneOAuthExchangeError,
  PlaneOAuthNotConfiguredError,
} from '@/lib/import/plane/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  IMPORT_PATH,
  PLANE_OAUTH_BASE_COOKIE,
  PLANE_OAUTH_SLUG_COOKIE,
  PLANE_OAUTH_STATE_COOKIE,
} from '../start/route';

// GET /api/import/plane/oauth/callback (Story 7.16 · MOTIR-1656) — step 2 of the
// Plane "Connect" grant. Plane redirects the member back with `code` + `state`.
// The identity binds to the SIGNED-IN member + active workspace, so this route
// requires a workspace context. We verify the CSRF state against the cookie,
// replay the stashed connect context (instance base URL + workspace slug) so the
// exchange runs against the SAME host, hand the code to the service (exchange +
// encrypted persist), and redirect back to the import wizard with a status the
// UI renders as a banner.
//
// Routes are HTTP-only (CLAUDE.md): the service owns the exchange, the substrate
// owns encryption + the transaction, and this maps the typed errors to redirect
// statuses.

function importRedirect(status: string): NextResponse {
  const res = NextResponse.redirect(`${resolveBaseUrlTrimmed()}${IMPORT_PATH}?import=${status}`);
  // The state nonce + connect context are single-use — clear them on every
  // terminal outcome.
  res.cookies.delete(PLANE_OAUTH_STATE_COOKIE);
  res.cookies.delete(PLANE_OAUTH_BASE_COOKIE);
  res.cookies.delete(PLANE_OAUTH_SLUG_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await resolveWorkspaceContext(req);
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const params = req.nextUrl.searchParams;

  // Plane bounces back with ?error=access_denied when the member declines.
  if (params.get('error')) return importRedirect('plane_denied');

  const code = params.get('code');
  const state = params.get('state');
  const cookieState = req.cookies.get(PLANE_OAUTH_STATE_COOKIE)?.value ?? null;
  if (!code || !state || !cookieState || state !== cookieState) {
    return importRedirect('plane_state_error');
  }

  const baseUrl = req.cookies.get(PLANE_OAUTH_BASE_COOKIE)?.value ?? null;
  const workspaceSlug = req.cookies.get(PLANE_OAUTH_SLUG_COOKIE)?.value ?? null;

  try {
    await planeImportOAuthService.completeOAuthCallback({
      code,
      baseUrl,
      workspaceSlug,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return importRedirect('plane_connected');
  } catch (err) {
    if (err instanceof PlaneInvalidBaseUrlError) return importRedirect('plane_invalid_url');
    if (err instanceof PlaneOAuthNotConfiguredError) return importRedirect('plane_not_configured');
    if (err instanceof PlaneOAuthExchangeError) return importRedirect('plane_error');
    throw err;
  }
}
