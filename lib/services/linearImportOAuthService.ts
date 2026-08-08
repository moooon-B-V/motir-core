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
// code→token exchange, refresh) and hands the tokens to the shared identity
// substrate (MOTIR-1653) for encryption + persistence. The routes are HTTP-only;
// this service holds the vendor protocol. Mirrors jiraOAuthService /
// planeImportOAuthService.
//
// Config is read at CALL time (never module load): a self-hosted deployment that
// never wires Linear must not crash on boot — the flow simply isn't reachable
// (the routes surface LinearOAuthNotConfiguredError as a redirect banner).
//
// TOKENS EXPIRE (MOTIR-2434). Linear migrated ALL OAuth2 applications to a
// refresh-token system on 2026-04-01: an access token is valid for 24 hours and
// the grant issues a `refresh_token` alongside it (no extra scope or authorize
// parameter is needed to receive one). So the stored token is read back by the
// Linear connector (MOTIR-940) through `getFreshConnection` — which re-mints and
// re-persists it when it has expired or is within the skew — and NOT replayed as
// a Bearer forever, which is how the connection used to die a day after connect.

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://api.linear.app/oauth/token';
const CALLBACK_PATH = '/api/import/linear/oauth/callback';
// Read-only scope — the importer only ever READS issues out of Linear.
const SCOPE = 'read';

// Refresh a token this many ms BEFORE its real expiry, so a call that starts
// just under the wire doesn't race the boundary mid-request. Same value + same
// shape as jiraOAuthService / planeImportOAuthService, so the three connectors
// read their credential the same way.
const EXPIRY_SKEW_MS = 60_000;

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

/** The decrypted live connection the Linear connector (MOTIR-940) needs: a fresh
 *  Bearer token. Linear stores no per-connection metadata (unlike Jira's cloud
 *  id / Plane's base URL), so the token is the whole connection. SERVER-SIDE
 *  ONLY — never serialise it. */
export interface LinearLiveConnection {
  accessToken: string;
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
   * Complete the connect grant: exchange `code` for an access + refresh token
   * and persist BOTH, ENCRYPTED, via the import-source identity substrate, bound
   * to the acting member + workspace (`source: 'linear'`). Returns the token-free
   * DTO. Throws LinearOAuthNotConfiguredError (unwired) or
   * LinearOAuthExchangeError (the exchange failed).
   */
  async completeOAuthCallback(args: {
    code: string;
    userId: string;
    workspaceId: string;
  }): Promise<ImportSourceIdentityDTO> {
    const { clientId, clientSecret } = resolveConfig();

    const token = await exchangeCode({ clientId, clientSecret, code: args.code });

    return importSourceIdentityService.upsertIdentity({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'linear',
      accessToken: token.accessToken,
      // The 24-hour access token is worthless on its own — without this the
      // connection dies a day after connect (MOTIR-2434).
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
    });
  },

  /**
   * The server-to-server read the connector (MOTIR-940) uses: return the acting
   * member's live Linear connection for `workspaceId`, refreshing the access
   * token first when it has expired (or is about to). Returns null when the
   * member hasn't connected Linear. The token is SERVER-SIDE ONLY — never
   * serialise it. Throws LinearOAuthExchangeError when a refresh is needed but
   * fails / no refresh token is stored.
   *
   * CONCURRENT REFRESHES ARE FINE, DELIBERATELY. Two import runs that both find
   * the token expired each read the stored refresh token fresh and each POST it;
   * Linear grants "a 30-minute grace period to allow for network errors" on
   * consuming a refresh token, so the second POST is answered with a valid token
   * rather than rejected. That is why this path takes no row lock and does not
   * serialise — the loser of the race gets a working token, not a hard failure.
   */
  async getFreshConnection(args: {
    userId: string;
    workspaceId: string;
  }): Promise<LinearLiveConnection | null> {
    const live = await importSourceIdentityService.getLiveToken({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'linear',
    });
    if (!live) return null;

    const expired =
      live.expiresAt != null && live.expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
    if (!expired) return { accessToken: live.accessToken };

    // Expired (or within the skew) — refresh and re-store. A grant made before
    // MOTIR-2434 shipped has no stored refresh token, so it is unrecoverable
    // here: the member re-connects (the route the wizard already offers).
    if (!live.refreshToken) {
      throw new LinearOAuthExchangeError('access token expired and no refresh token is stored');
    }
    const { clientId, clientSecret } = resolveConfig();
    const refreshed = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken: live.refreshToken,
    });

    await importSourceIdentityService.upsertIdentity({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'linear',
      accessToken: refreshed.accessToken,
      // Linear ROTATES the refresh token — persist the new one, or keep the
      // prior one if the response omitted it. (No metadata to re-pass: unlike
      // Jira / Plane, a Linear identity stores none.)
      refreshToken: refreshed.refreshToken ?? live.refreshToken,
      expiresAt: refreshed.expiresAt,
    });

    return { accessToken: refreshed.accessToken };
  },
};

interface ExchangedToken {
  accessToken: string;
  /** The refresh token, or null when Linear returned none. */
  refreshToken: string | null;
  /** Access-token expiry, or null when Linear returns no `expires_in`. */
  expiresAt: Date | null;
}

interface LinearTokenResponse {
  access_token?: string;
  /** Issued by both grant types since the 2026-04-01 refresh-token migration. */
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
}

/** POST the authorization_code → token exchange. */
async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<ExchangedToken> {
  return toExchangedToken(
    await postToken({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: callbackUrl(),
      code: args.code,
      grant_type: 'authorization_code',
    }),
  );
}

/** POST the refresh_token → token exchange. */
async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<ExchangedToken> {
  return toExchangedToken(
    await postToken({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      grant_type: 'refresh_token',
    }),
  );
}

/** Shared POST to Linear's token endpoint (form-urlencoded, both grant types). A
 *  body without `access_token` is the failure path. Never surfaces Linear's raw
 *  body (it can echo the code / refresh token). */
async function postToken(body: Record<string, string>): Promise<LinearTokenResponse> {
  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (err) {
    throw new LinearOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new LinearOAuthExchangeError(`token endpoint returned ${res.status}`);

  let payload: LinearTokenResponse;
  try {
    payload = (await res.json()) as LinearTokenResponse;
  } catch {
    throw new LinearOAuthExchangeError('token endpoint returned a non-JSON body');
  }
  if (!payload.access_token) {
    throw new LinearOAuthExchangeError(
      payload.error ? `token error: ${payload.error}` : 'no access_token in response',
    );
  }
  return payload;
}

function toExchangedToken(payload: LinearTokenResponse): ExchangedToken {
  return {
    accessToken: payload.access_token as string,
    refreshToken: payload.refresh_token ?? null,
    expiresAt:
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
