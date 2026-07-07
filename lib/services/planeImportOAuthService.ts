import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import {
  PlaneInvalidBaseUrlError,
  PlaneOAuthExchangeError,
  PlaneOAuthNotConfiguredError,
} from '@/lib/import/plane/errors';
import type { ImportSourceIdentityDTO } from '@/lib/dto/importSourceIdentity';

// Plane "Connect" OAuth service (Story 7.16 · MOTIR-1656) — the "Model A" grant
// that lets a member connect Plane for the issue importer WITHOUT pasting a
// personal API key. Owns the OAuth orchestration (authorize-URL build,
// code→token exchange, refresh) and hands the token + per-connection context to
// the shared identity substrate (MOTIR-1653) for encryption + persistence. The
// routes are HTTP-only; this service holds the vendor protocol. Mirrors
// jiraOAuthService.
//
// Config is read at CALL time (never module load): a self-hosted deployment
// that never wires Plane must not crash on boot — the flow simply isn't
// reachable (the routes surface PlaneOAuthNotConfiguredError as a redirect).
//
// PER-INSTANCE base URL (the self-hosted nuance). Plane's OAuth endpoints live
// under `/auth/o/*` on the API host, and — as shipped today — ONLY exist on
// Plane Cloud (`api.plane.so`); the open-source Community Edition does not yet
// expose them (makeplane/plane#8782). So this flow is Cloud-first, but the base
// URL is accepted UP FRONT so an instance that DOES register an OAuth app (an
// enterprise self-host, or CE once it lands) can be pointed at: Cloud resolves
// its client id/secret from `PLANE_OAUTH_CLIENT_ID` / `_SECRET`; a self-hosted
// host resolves its OWN registered app from `PLANE_OAUTH_INSTANCES` (a
// host→credentials JSON map). Everything downstream keys off the resolved API
// origin.
//
// The stored token is an OAuth Bearer token; it + the base URL + workspace slug
// are read back by the Plane connector (MOTIR-1639) via `getFreshConnection`,
// so the connector authenticates from the encrypted store with no wizard-entered
// PAT.

/** The default instance the connect form pre-fills — Plane Cloud's web app. */
export const PLANE_CLOUD_APP_URL = 'https://app.plane.so';
/** Plane Cloud serves both `/auth/o/*` and `/api/v1/*` from the API origin. */
const PLANE_CLOUD_API_ORIGIN = 'https://api.plane.so';
const AUTHORIZE_PATH = '/auth/o/authorize-app/';
const TOKEN_PATH = '/auth/o/token/';
const CALLBACK_PATH = '/api/import/plane/oauth/callback';

// Refresh a token this many ms BEFORE its real expiry, so a call that starts
// just under the wire doesn't race the boundary mid-request.
const EXPIRY_SKEW_MS = 60_000;

/** The resolved OAuth host + whether it is Plane Cloud, derived from the raw
 *  instance base URL the member supplied. `apiOrigin` is where `/auth/o/*` and
 *  `/api/v1/*` live AND what the connector stores as its `baseUrl`. */
export interface PlaneInstance {
  apiOrigin: string;
  isCloud: boolean;
}

interface PlaneOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Validate + normalise the instance base URL the member supplied into the API
 * origin every downstream call keys off. Plane Cloud's web app
 * (`app.plane.so`, the default) maps to the `api.plane.so` origin; a
 * self-hosted instance serves `/auth/o` + `/api/v1` from its own single origin,
 * so its origin is used as-is. Throws PlaneInvalidBaseUrlError for anything that
 * isn't an absolute http(s) URL (a typo must not reach OAuth host resolution).
 */
export function resolvePlaneInstance(rawBaseUrl?: string | null): PlaneInstance {
  const raw = (rawBaseUrl ?? '').trim() || PLANE_CLOUD_APP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlaneInvalidBaseUrlError();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PlaneInvalidBaseUrlError();
  }
  const host = url.host.toLowerCase();
  const isCloud = host === 'app.plane.so' || host === 'plane.so' || host === 'api.plane.so';
  const apiOrigin = isCloud ? PLANE_CLOUD_API_ORIGIN : `${url.protocol}//${url.host}`;
  return { apiOrigin, isCloud };
}

/** Resolve the OAuth app credentials for one instance. Cloud reads the dedicated
 *  env vars; a self-hosted origin reads its own entry from the
 *  `PLANE_OAUTH_INSTANCES` JSON map (keyed by API origin OR host). Throws
 *  PlaneOAuthNotConfiguredError when the target instance isn't wired. */
function resolveConfig(instance: PlaneInstance): PlaneOAuthConfig {
  if (instance.isCloud) {
    const clientId = process.env['PLANE_OAUTH_CLIENT_ID'];
    const clientSecret = process.env['PLANE_OAUTH_CLIENT_SECRET'];
    if (!clientId || !clientSecret) throw new PlaneOAuthNotConfiguredError();
    return { clientId, clientSecret };
  }
  const entry = lookupSelfHostConfig(instance.apiOrigin);
  if (!entry) {
    throw new PlaneOAuthNotConfiguredError(
      `No Plane OAuth app configured for ${instance.apiOrigin}. Add it to PLANE_OAUTH_INSTANCES.`,
    );
  }
  return entry;
}

/** Parse `PLANE_OAUTH_INSTANCES` and look one host's credentials up. Malformed
 *  JSON is treated as "unconfigured" (not a crash) — the route surfaces it as a
 *  not-configured redirect. Matches on the full API origin or its host. */
function lookupSelfHostConfig(apiOrigin: string): PlaneOAuthConfig | null {
  const raw = process.env['PLANE_OAUTH_INSTANCES'];
  if (!raw) return null;
  let map: Record<string, { clientId?: string; clientSecret?: string }>;
  try {
    map = JSON.parse(raw) as typeof map;
  } catch {
    return null;
  }
  if (!map || typeof map !== 'object') return null;

  const host = new URL(apiOrigin).host.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    const keyHost = safeHost(key);
    if (key === apiOrigin || (keyHost && keyHost === host)) {
      if (value?.clientId && value.clientSecret) {
        return { clientId: value.clientId, clientSecret: value.clientSecret };
      }
      return null;
    }
  }
  return null;
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^\/+|\/+$/g, '') || null;
  }
}

/** The redirect_uri Plane sends the member back to — derived from the canonical
 *  base URL so it matches the value registered on the Plane OAuth app. */
function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

/** The decrypted live connection the Plane connector (MOTIR-1639) needs: a fresh
 *  Bearer token, the API origin it addresses (`{baseUrl}/api/v1/...`), and the
 *  workspace slug the connector scopes to. Token is SERVER-SIDE ONLY. */
export interface PlaneLiveConnection {
  accessToken: string;
  baseUrl: string;
  workspaceSlug: string | null;
}

export const planeImportOAuthService = {
  /**
   * Build the Plane authorize URL for the connect grant against `baseUrl`'s
   * instance. `state` is the caller-minted CSRF nonce the callback re-checks.
   * Throws PlaneInvalidBaseUrlError (bad instance URL) or
   * PlaneOAuthNotConfiguredError (the instance isn't wired).
   */
  buildAuthorizeUrl(args: { state: string; baseUrl?: string | null }): string {
    const instance = resolvePlaneInstance(args.baseUrl);
    const { clientId } = resolveConfig(instance);
    const url = new URL(`${instance.apiOrigin}${AUTHORIZE_PATH}`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', args.state);
    return url.toString();
  },

  /**
   * Complete the connect grant: exchange `code` for an access (+ refresh) token
   * against the SAME instance the authorize step used, and persist it ENCRYPTED
   * via the identity substrate, bound to the acting member + workspace
   * (`source: 'plane'`), with `metadata.baseUrl` (the API origin the connector
   * calls) + `metadata.workspaceSlug`. Returns the token-free DTO. Throws
   * PlaneInvalidBaseUrlError, PlaneOAuthNotConfiguredError, or
   * PlaneOAuthExchangeError.
   */
  async completeOAuthCallback(args: {
    code: string;
    baseUrl?: string | null;
    workspaceSlug?: string | null;
    userId: string;
    workspaceId: string;
  }): Promise<ImportSourceIdentityDTO> {
    const instance = resolvePlaneInstance(args.baseUrl);
    const { clientId, clientSecret } = resolveConfig(instance);

    const token = await exchangeCode({
      instance,
      clientId,
      clientSecret,
      code: args.code,
    });

    // Prefer a workspace slug Plane returned with the grant (it binds the token
    // to the installed workspace); fall back to the one the member supplied up
    // front. Trimmed to null so an empty string never masquerades as a slug.
    const workspaceSlug =
      normalizeSlug(token.workspaceSlug) ?? normalizeSlug(args.workspaceSlug) ?? undefined;

    return importSourceIdentityService.upsertIdentity({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'plane',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      metadata: { baseUrl: instance.apiOrigin, ...(workspaceSlug ? { workspaceSlug } : {}) },
    });
  },

  /**
   * The server-to-server read the connector (MOTIR-1639) uses: return the acting
   * member's live Plane connection for `workspaceId`, refreshing the access
   * token first when it has expired (or is about to) and a refresh token is
   * stored. Returns null when the member hasn't connected Plane. The token is
   * SERVER-SIDE ONLY — never serialise it. Throws PlaneOAuthExchangeError when a
   * refresh is needed but fails / no refresh token is stored.
   */
  async getFreshConnection(args: {
    userId: string;
    workspaceId: string;
  }): Promise<PlaneLiveConnection | null> {
    const live = await importSourceIdentityService.getLiveToken({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'plane',
    });
    if (!live) return null;

    const baseUrl = live.metadata?.baseUrl ?? PLANE_CLOUD_API_ORIGIN;
    const workspaceSlug = live.metadata?.workspaceSlug ?? null;

    const expired =
      live.expiresAt != null && live.expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
    if (!expired) {
      return { accessToken: live.accessToken, baseUrl, workspaceSlug };
    }

    if (!live.refreshToken) {
      throw new PlaneOAuthExchangeError('access token expired and no refresh token is stored');
    }
    const instance = resolvePlaneInstance(baseUrl);
    const { clientId, clientSecret } = resolveConfig(instance);
    const refreshed = await refreshAccessToken({
      instance,
      clientId,
      clientSecret,
      refreshToken: live.refreshToken,
    });

    await importSourceIdentityService.upsertIdentity({
      userId: args.userId,
      workspaceId: args.workspaceId,
      source: 'plane',
      accessToken: refreshed.accessToken,
      // django-oauth-toolkit rotates the refresh token — persist the new one, or
      // keep the prior one if the response omitted it.
      refreshToken: refreshed.refreshToken ?? live.refreshToken,
      expiresAt: refreshed.expiresAt,
      // Re-pass metadata: upsert replaces the row, so omitting it would NULL the
      // base URL / workspace slug the connector depends on.
      metadata: live.metadata,
    });

    return { accessToken: refreshed.accessToken, baseUrl, workspaceSlug };
  },
};

interface ExchangedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  workspaceSlug: string | null;
}

interface PlaneTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  // Plane binds a bot/user token to the installed workspace; when present, this
  // is the authoritative slug for the grant.
  workspace_slug?: string;
}

/** POST the authorization_code → token exchange (form-urlencoded, per
 *  django-oauth-toolkit's token endpoint). */
async function exchangeCode(args: {
  instance: PlaneInstance;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<ExchangedToken> {
  const payload = await postToken(args.instance, {
    grant_type: 'authorization_code',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: callbackUrl(),
  });
  if (!payload.access_token) {
    throw new PlaneOAuthExchangeError('no access_token in token response');
  }
  return toExchangedToken(payload);
}

/** POST the refresh_token → token exchange. */
async function refreshAccessToken(args: {
  instance: PlaneInstance;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<ExchangedToken> {
  const payload = await postToken(args.instance, {
    grant_type: 'refresh_token',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
  });
  if (!payload.access_token) {
    throw new PlaneOAuthExchangeError('no access_token in refresh response');
  }
  return toExchangedToken(payload);
}

function toExchangedToken(payload: PlaneTokenResponse): ExchangedToken {
  return {
    accessToken: payload.access_token as string,
    refreshToken: payload.refresh_token ?? null,
    expiresAt:
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
    workspaceSlug: normalizeSlug(payload.workspace_slug) ?? null,
  };
}

/** Shared POST to one instance's token endpoint (both grant types). Never
 *  surfaces Plane's raw body (it can echo the code / token). */
async function postToken(
  instance: PlaneInstance,
  body: Record<string, string>,
): Promise<PlaneTokenResponse> {
  const tokenUrl = `${instance.apiOrigin}${TOKEN_PATH}`;
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (err) {
    throw new PlaneOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new PlaneOAuthExchangeError(`token endpoint returned ${res.status}`);
  try {
    return (await res.json()) as PlaneTokenResponse;
  } catch {
    throw new PlaneOAuthExchangeError('token endpoint returned a non-JSON body');
  }
}

function normalizeSlug(slug?: string | null): string | undefined {
  const trimmed = slug?.trim();
  return trimmed ? trimmed : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
