import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import {
  LinearOAuthExchangeError,
  LinearOAuthNotConfiguredError,
} from '@/lib/import/linear/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { ImportSourceIdentityDTO } from '@/lib/dto/importSourceIdentity';

// Linear import "Connect" flow service (Story 7.16 · MOTIR-1655) — the "Model A"
// OAuth grant that lets a member connect Linear for the issue importer WITHOUT
// pasting a personal API key. Owns the OAuth orchestration (authorize-URL build,
// code→token exchange) and hands the token to the shared identity substrate
// (MOTIR-1653) for encryption + persistence. The routes are HTTP-only; this
// service holds the vendor protocol. Mirrors githubIdentityService.
//
// Config is read at CALL time (never module load): a self-hosted deployment that
// never wires Linear must not crash on boot — the flow simply isn't reachable
// (the routes surface LinearOAuthNotConfiguredError as a redirect banner).
//
// The stored token is later read back by the Linear connector (MOTIR-940) as a
// Bearer token (`authScheme: 'bearer'`) via importSourceIdentityService — so the
// connector authenticates from the encrypted store with no wizard-entered secret.

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://api.linear.app/oauth/token';
const CALLBACK_PATH = '/api/import/linear/oauth/callback';
// Read-only scope — the importer only ever READS issues out of Linear.
const SCOPE = 'read';

interface LinearOAuthConfig {
  clientId: string;
  clientSecret: string;
}

function resolveConfig(): LinearOAuthConfig {
  const clientId = process.env['LINEAR_OAUTH_CLIENT_ID'];
  const clientSecret = process.env['LINEAR_OAUTH_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new LinearOAuthNotConfiguredError();
  return { clientId, clientSecret };
}

/** The redirect_uri Linear sends the member back to — derived from the canonical
 *  base URL so it matches the value registered on the Linear OAuth app. */
function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

export const linearImportOAuthService = {
  /**
   * Build the Linear authorize URL for the connect grant. `state` is the
   * caller-minted CSRF nonce the callback re-checks. Throws
   * LinearOAuthNotConfiguredError when the app isn't wired.
   */
  buildAuthorizeUrl(state: string): string {
    const { clientId } = resolveConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('state', state);
    // Force a fresh consent so a re-connect always re-issues (and re-binds) a
    // token rather than silently reusing a prior grant.
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  },

  /**
   * Complete the connect grant: exchange `code` for an access token and persist
   * it ENCRYPTED via the import-source identity substrate, bound to the acting
   * member + workspace (`source: 'linear'`). Returns the token-free DTO. Throws
   * LinearOAuthNotConfiguredError (unwired) or LinearOAuthExchangeError (the
   * exchange failed).
   */
  async completeOAuthCallback(args: {
    code: string;
    userId: string;
    workspaceId: string;
  }): Promise<ImportSourceIdentityDTO> {
    const { clientId, clientSecret } = resolveConfig();

    const token = await exchangeCodeForToken({ clientId, clientSecret, code: args.code });

    return importSourceIdentityService.upsertIdentity({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'linear',
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
    });
  },
};

interface LinearAccessToken {
  accessToken: string;
  /** Access-token expiry, or null when Linear returns no `expires_in`. */
  expiresAt: Date | null;
}

/** POST the code→token exchange (form-urlencoded, per Linear's OAuth2 token
 *  endpoint). A body without `access_token` is the failure path. Never surfaces
 *  Linear's raw body (it can echo the code). */
async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<LinearAccessToken> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: callbackUrl(),
    code: args.code,
    grant_type: 'authorization_code',
  });

  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new LinearOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new LinearOAuthExchangeError(`token endpoint returned ${res.status}`);

  let payload: { access_token?: string; expires_in?: number; error?: string };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new LinearOAuthExchangeError('token endpoint returned a non-JSON body');
  }
  if (!payload.access_token) {
    throw new LinearOAuthExchangeError(
      payload.error ? `token error: ${payload.error}` : 'no access_token in response',
    );
  }

  const expiresAt =
    typeof payload.expires_in === 'number' && payload.expires_in > 0
      ? new Date(Date.now() + payload.expires_in * 1000)
      : null;

  return { accessToken: payload.access_token, expiresAt };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
