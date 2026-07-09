import { NextResponse, type NextRequest } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { linearImportOAuthService } from '@/lib/services/linearImportOAuthService';
import {
  LinearOAuthExchangeError,
  LinearOAuthNotConfiguredError,
} from '@/lib/import/linear/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  IMPORT_OAUTH_RETURN_COOKIE,
  appendStatus,
  safeImportReturnPath,
} from '@/lib/import/oauthReturn';
import { LINEAR_OAUTH_STATE_COOKIE } from '../start/route';

// GET /api/import/linear/oauth/callback (Story 7.16 · MOTIR-1655) — step 2 of
// the Linear "Connect" grant. Linear redirects the member back with `code` +
// `state`. The identity binds to the SIGNED-IN member + active workspace, so
// this route requires a workspace context. We verify the CSRF state against the
// cookie, hand the code to the service (exchange + encrypted persist), and
// redirect back to the import wizard with a status the UI renders as a banner.
//
// Routes are HTTP-only (CLAUDE.md): the service owns the exchange, the substrate
// owns encryption + the transaction, and this maps the typed errors to redirect
// statuses.

function importRedirect(returnTo: string, status: string): NextResponse {
  const res = NextResponse.redirect(
    `${resolveBaseUrlTrimmed()}${appendStatus(returnTo, 'import', status)}`,
  );
  // The state nonce + the stashed return path are single-use — clear them on
  // every terminal outcome.
  res.cookies.delete(LINEAR_OAUTH_STATE_COOKIE);
  res.cookies.delete(IMPORT_OAUTH_RETURN_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const returnTo = safeImportReturnPath(req.cookies.get(IMPORT_OAUTH_RETURN_COOKIE)?.value);
  const params = req.nextUrl.searchParams;

  // Linear bounces back with ?error=access_denied when the member declines.
  if (params.get('error')) return importRedirect(returnTo, 'linear_denied');

  const code = params.get('code');
  const state = params.get('state');
  const cookieState = req.cookies.get(LINEAR_OAUTH_STATE_COOKIE)?.value ?? null;
  if (!code || !state || !cookieState || state !== cookieState) {
    return importRedirect(returnTo, 'linear_state_error');
  }

  try {
    await linearImportOAuthService.completeOAuthCallback({
      code,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return importRedirect(returnTo, 'linear_connected');
  } catch (err) {
    if (err instanceof LinearOAuthNotConfiguredError)
      return importRedirect(returnTo, 'linear_not_configured');
    if (err instanceof LinearOAuthExchangeError) return importRedirect(returnTo, 'linear_error');
    throw err;
  }
}
