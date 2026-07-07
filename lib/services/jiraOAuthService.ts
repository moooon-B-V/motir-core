import { createHash } from 'node:crypto';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { JiraOAuthExchangeError, JiraOAuthNotConfiguredError } from '@/lib/import/jira/errors';
import type { ImportSourceIdentityDTO } from '@/lib/dto/importSourceIdentity';

// Jira OAuth 2.0 (3LO) connect service (Story 7.16 · MOTIR-1654) — "Model A"
// for the import wizard's Jira step: the member grants Motir read access to
// their Jira, and we store the resulting Bearer token ENCRYPTED via the
// ImportSourceIdentity substrate (MOTIR-1653) so the live connector (MOTIR-940)
// authenticates with a stored token, never a credential pasted into the wizard.
// Mirrors githubIdentityService — owns the OAuth orchestration (authorize-URL
// build with PKCE, code→token exchange, the `accessible-resources` read that
// resolves the cloud id → site URL, token refresh via offline_access); the
// routes are HTTP-only.
//
// Config is read at CALL time (never module load): a self-hosted deployment
// that never wires Jira import must not crash on boot — the flow simply isn't
// reachable (routes surface JiraOAuthNotConfiguredError as a redirect).
//
// Atlassian 3LO endpoints (auth.atlassian.com) + the api.atlassian.com gateway.
// The OAuth Bearer token does NOT address the tenant's `*.atlassian.net` host
// directly — every REST call goes through the gateway at
// `https://api.atlassian.com/ex/jira/<cloudId>`. So we persist the `cloudId`
// (the connector builds that base URL) AND the human-facing `siteUrl`.

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const API_GATEWAY = 'https://api.atlassian.com';
const CALLBACK_PATH = '/api/import/jira/oauth/callback';

// The read scopes the import needs, plus offline_access for a refresh token.
export const JIRA_OAUTH_SCOPES = 'read:jira-work offline_access';

// Refresh a token this many ms BEFORE its real expiry, so a call that starts
// just under the wire doesn't race the boundary mid-request.
const EXPIRY_SKEW_MS = 60_000;

interface JiraOAuthConfig {
  clientId: string;
  clientSecret: string;
}

function resolveConfig(): JiraOAuthConfig {
  const clientId = process.env['JIRA_OAUTH_CLIENT_ID'];
  const clientSecret = process.env['JIRA_OAUTH_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new JiraOAuthNotConfiguredError();
  return { clientId, clientSecret };
}

/** The redirect_uri Atlassian sends the member back to — derived from the
 *  canonical base URL so it matches the value registered on the OAuth app. */
function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

/** The api.atlassian.com gateway base URL a connector uses with the 3LO Bearer
 *  token to reach one cloud site's REST API (`{base}/rest/api/3/...`). */
export function jiraApiBaseUrl(cloudId: string): string {
  return `${API_GATEWAY}/ex/jira/${cloudId}`;
}

/** PKCE S256 challenge: base64url(sha256(verifier)). Kept here (not the route)
 *  so the crypto shape lives in one place with the flow it belongs to. */
function codeChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** One Atlassian `accessible-resources` entry — the cloud sites the token can
 *  reach. `id` is the cloud id; `url` is the site base (e.g. acme.atlassian.net). */
interface AccessibleResource {
  id: string;
  url: string;
  name?: string;
}

/** The token endpoint's response (authorization_code AND refresh_token grants). */
interface JiraTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** The decrypted live connection a connector needs: a fresh Bearer token + the
 *  gateway base URL to address the resolved cloud site (+ the human site URL). */
export interface JiraLiveConnection {
  accessToken: string;
  cloudId: string;
  siteUrl: string | null;
  /** `https://api.atlassian.com/ex/jira/<cloudId>` — the connector's baseUrl. */
  apiBaseUrl: string;
}

export const jiraOAuthService = {
  /**
   * Build the Atlassian authorize URL for the 3LO grant. `state` is the
   * caller-minted CSRF nonce the callback re-checks; `codeVerifier` is the
   * caller-minted PKCE secret it stashes and replays at token exchange (we send
   * only its S256 challenge here). Throws JiraOAuthNotConfiguredError when the
   * app isn't wired.
   */
  buildAuthorizeUrl(state: string, codeVerifier: string): string {
    const { clientId } = resolveConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('audience', 'api.atlassian.com');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', JIRA_OAUTH_SCOPES);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    // offline_access only yields a refresh token when consent is forced.
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('code_challenge', codeChallengeS256(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  },

  /**
   * Complete the 3LO grant: exchange `code` (+ the PKCE `codeVerifier`) for an
   * access + refresh token, resolve the cloud site via `accessible-resources`,
   * and upsert an encrypted ImportSourceIdentity bound to `userId` in
   * `workspaceId` (the service runs it under `withUserContext`, so RLS binds it
   * to the acting member). Returns the token-free DTO. Throws
   * JiraOAuthNotConfiguredError (unwired) or JiraOAuthExchangeError (exchange /
   * resource read failed).
   */
  async completeOAuthCallback(args: {
    code: string;
    codeVerifier: string;
    userId: string;
    workspaceId: string;
  }): Promise<ImportSourceIdentityDTO> {
    const { clientId, clientSecret } = resolveConfig();

    const token = await exchangeCode({
      clientId,
      clientSecret,
      code: args.code,
      codeVerifier: args.codeVerifier,
    });
    const resource = await resolvePrimaryResource(token.accessToken);

    return importSourceIdentityService.upsertIdentity({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'jira',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      metadata: { cloudId: resource.id, siteUrl: resource.url },
    });
  },

  /**
   * The server-to-server read the connector (MOTIR-940) uses: return the acting
   * member's live Jira connection for `workspaceId`, refreshing the access token
   * first when it has expired (or is about to). Returns null when the member has
   * not connected Jira. The token is SERVER-SIDE ONLY — never serialise it.
   * Throws JiraOAuthExchangeError when a refresh is needed but fails / no
   * refresh token is stored.
   */
  async getFreshConnection(args: {
    userId: string;
    workspaceId: string;
  }): Promise<JiraLiveConnection | null> {
    const live = await importSourceIdentityService.getLiveToken({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'jira',
    });
    if (!live) return null;

    const cloudId = live.metadata?.cloudId;
    if (!cloudId) {
      throw new JiraOAuthExchangeError('stored identity is missing its Jira cloud id');
    }
    const siteUrl = live.metadata?.siteUrl ?? null;

    const expired =
      live.expiresAt != null && live.expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
    if (!expired) {
      return {
        accessToken: live.accessToken,
        cloudId,
        siteUrl,
        apiBaseUrl: jiraApiBaseUrl(cloudId),
      };
    }

    // Expired (or within the skew) — refresh via offline_access and re-store.
    if (!live.refreshToken) {
      throw new JiraOAuthExchangeError('access token expired and no refresh token is stored');
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
      source: 'jira',
      accessToken: refreshed.accessToken,
      // Atlassian ROTATES the refresh token — persist the new one, or keep the
      // prior one if the response omitted it.
      refreshToken: refreshed.refreshToken ?? live.refreshToken,
      expiresAt: refreshed.expiresAt,
      // Re-pass metadata: upsert replaces the row, so omitting it would NULL the
      // cloud id / site URL the connector depends on.
      metadata: live.metadata,
    });

    return {
      accessToken: refreshed.accessToken,
      cloudId,
      siteUrl,
      apiBaseUrl: jiraApiBaseUrl(cloudId),
    };
  },
};

interface ExchangedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/** POST the authorization_code → token exchange (with the PKCE verifier). */
async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
}): Promise<ExchangedToken> {
  const payload = await postToken({
    grant_type: 'authorization_code',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: callbackUrl(),
    code_verifier: args.codeVerifier,
  });
  if (!payload.access_token) {
    throw new JiraOAuthExchangeError('no access_token in token response');
  }
  return toExchangedToken(payload);
}

/** POST the refresh_token → token exchange (offline_access). */
async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<ExchangedToken> {
  const payload = await postToken({
    grant_type: 'refresh_token',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
  });
  if (!payload.access_token) {
    throw new JiraOAuthExchangeError('no access_token in refresh response');
  }
  return toExchangedToken(payload);
}

function toExchangedToken(payload: JiraTokenResponse): ExchangedToken {
  return {
    accessToken: payload.access_token as string,
    refreshToken: payload.refresh_token ?? null,
    expiresAt:
      typeof payload.expires_in === 'number'
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
  };
}

/** Shared POST to Atlassian's token endpoint (both grant types). Never surfaces
 *  Atlassian's raw body (it can echo the code / token). */
async function postToken(body: Record<string, string>): Promise<JiraTokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new JiraOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new JiraOAuthExchangeError(`token endpoint returned ${res.status}`);
  try {
    return (await res.json()) as JiraTokenResponse;
  } catch {
    throw new JiraOAuthExchangeError('token endpoint returned a non-JSON body');
  }
}

/** Resolve the cloud site the token grants — the FIRST accessible resource (the
 *  3LO minimal flow exposes no site hint, so we bind the primary one). */
async function resolvePrimaryResource(accessToken: string): Promise<AccessibleResource> {
  let res: Response;
  try {
    res = await fetch(ACCESSIBLE_RESOURCES_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new JiraOAuthExchangeError(`accessible-resources unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new JiraOAuthExchangeError(`accessible-resources returned ${res.status}`);

  let resources: AccessibleResource[];
  try {
    resources = (await res.json()) as AccessibleResource[];
  } catch {
    throw new JiraOAuthExchangeError('accessible-resources returned a non-JSON body');
  }
  const primary = Array.isArray(resources) ? resources[0] : undefined;
  if (!primary?.id || !primary.url) {
    throw new JiraOAuthExchangeError('no accessible Jira site for this grant');
  }
  return primary;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
