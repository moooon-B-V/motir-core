import {
  GitlabOAuthExchangeError,
  GitlabOAuthNotConfiguredError,
  GitlabTokenRefreshError,
} from './errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// GitLab OAuth HTTP leaf (Story 7.23 · MOTIR-1474). Pure host I/O — the authorize
// URL, the code→token exchange, and the refresh-token rotation — with NO DB and no
// business logic (the service owns persistence + the transaction). GitLab, unlike
// GitHub's App model, issues a short-lived access token (~2h) + a refresh token
// per connection; the refresh token is ROTATED on every refresh, so each call
// returns a fresh pair the service must persist.
//
// Config is read at CALL time (never module load), so a self-hosted deployment
// that never wires GitLab does not crash on boot — the flow simply isn't reachable.
// The GitLab instance base URL is configurable (`GITLAB_BASE_URL`, default
// gitlab.com) so a self-managed GitLab works too. Mirrors `githubIdentityService`'s
// exchange helpers, lifted into a leaf because the refresh path also needs them.

const DEFAULT_BASE_URL = 'https://gitlab.com';
const CALLBACK_PATH = '/api/gitlab/oauth/callback';
// The GitLab OAuth scope Motir needs: `api` grants project reads, repository
// archive download (the code-graph feed), and MR/pipeline reads behind the seam.
const SCOPE = 'api';

interface GitlabOAuthConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** The GitLab instance base URL (no trailing slash), from `GITLAB_BASE_URL` or
 *  gitlab.com. Exported so the provider's API calls address the same instance. */
export function gitlabBaseUrl(): string {
  const raw = process.env['GITLAB_BASE_URL'];
  const base = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

function resolveConfig(): GitlabOAuthConfig {
  const clientId = process.env['GITLAB_APP_CLIENT_ID'];
  const clientSecret = process.env['GITLAB_APP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new GitlabOAuthNotConfiguredError();
  return { clientId, clientSecret, baseUrl: gitlabBaseUrl() };
}

/** The redirect_uri GitLab sends the user back to — derived from the canonical
 *  base URL so it matches the value registered on the GitLab OAuth application. */
export function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

/** A freshly-issued (or refreshed) GitLab token set. `refreshToken` is rotated on
 *  each refresh, so the caller MUST persist the returned value. */
export interface GitlabTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** The GitLab user fields the connection binding needs. GitLab's `id` is a JSON
 *  number; we carry it as a string (never do math on it). */
export interface GitlabUser {
  id: number;
  username: string;
}

/**
 * Build the GitLab authorize URL for the connect grant. `state` is the caller-
 * minted signed CSRF state the callback re-checks. Throws
 * GitlabOAuthNotConfiguredError when the app isn't wired.
 */
export function buildAuthorizeUrl(state: string): string {
  const { clientId, baseUrl } = resolveConfig();
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SCOPE);
  return url.toString();
}

/**
 * Exchange an authorization `code` for the initial token set. Throws
 * GitlabOAuthNotConfiguredError (unwired) or GitlabOAuthExchangeError (the
 * endpoint erred or returned no token). Never surfaces GitLab's raw body.
 */
export async function exchangeCodeForToken(code: string): Promise<GitlabTokenSet> {
  const { clientId, clientSecret, baseUrl } = resolveConfig();
  return postToken(
    baseUrl,
    {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(),
    },
    (detail) => new GitlabOAuthExchangeError(detail),
  );
}

/**
 * Exchange a stored refresh token for a fresh token set (access + a ROTATED
 * refresh token). Throws GitlabOAuthNotConfiguredError (unwired) or
 * GitlabTokenRefreshError (the refresh token was rejected / endpoint erred).
 */
export async function refreshAccessToken(refreshToken: string): Promise<GitlabTokenSet> {
  const { clientId, clientSecret, baseUrl } = resolveConfig();
  return postToken(
    baseUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
    (detail) => new GitlabTokenRefreshError(detail),
  );
}

/** Read the authenticated GitLab user for a freshly-minted access token. */
export async function fetchGitlabUser(accessToken: string): Promise<GitlabUser> {
  const { baseUrl } = resolveConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v4/user`, {
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'motir' },
    });
  } catch (err) {
    throw new GitlabOAuthExchangeError(`user endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new GitlabOAuthExchangeError(`user endpoint returned ${res.status}`);

  let user: GitlabUser;
  try {
    user = (await res.json()) as GitlabUser;
  } catch {
    throw new GitlabOAuthExchangeError('user endpoint returned a non-JSON body');
  }
  if (typeof user.id !== 'number' || typeof user.username !== 'string') {
    throw new GitlabOAuthExchangeError('user endpoint returned an unexpected shape');
  }
  return user;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
  error?: string;
}

/** POST the shared `/oauth/token` endpoint for both the initial exchange and the
 *  refresh, mapping the failure to the caller's typed error. */
async function postToken(
  baseUrl: string,
  body: Record<string, string>,
  makeError: (detail: string) => Error,
): Promise<GitlabTokenSet> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw makeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw makeError(`token endpoint returned ${res.status}`);

  let payload: TokenResponse;
  try {
    payload = (await res.json()) as TokenResponse;
  } catch {
    throw makeError('token endpoint returned a non-JSON body');
  }
  if (!payload.access_token || !payload.refresh_token) {
    throw makeError(
      payload.error
        ? `token error: ${payload.error}`
        : 'token endpoint returned an unexpected shape',
    );
  }

  // GitLab reports `created_at` (unix seconds) + `expires_in` (seconds, ~7200).
  // Fall back to now when the instance omits `created_at`.
  const createdAtMs =
    typeof payload.created_at === 'number' ? payload.created_at * 1000 : Date.now();
  const expiresInMs = typeof payload.expires_in === 'number' ? payload.expires_in * 1000 : 0;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(createdAtMs + expiresInMs),
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
