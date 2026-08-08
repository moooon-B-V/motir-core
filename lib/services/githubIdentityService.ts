import { withUserContext } from '@/lib/workspaces/context';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { toGithubIdentityDTO } from '@/lib/mappers/githubMappers';
import { encryptToken, decryptToken } from '@/lib/github/tokenCrypto';
import { userOrgsClient, type GithubUserOrg } from '@/lib/github/userOrgs';
import { GithubOAuthExchangeError, GithubOAuthNotConfiguredError } from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { GithubIdentityDTO } from '@/lib/dto/github';

// GitHub OAuth user-identity service (Story 7.10 · MOTIR-1498) — "Grant 1" of
// the verified GitHub-App model: it proves which GitHub user a Motir member is
// and grants NO repo access (that's the installation grant, MOTIR-891). Owns
// the OAuth orchestration (authorize-URL build, code→token exchange, the
// `GET /user` read), token encryption, and the `withUserContext` transaction
// that binds the identity to the acting member. The routes are HTTP-only.
//
// Config is read at CALL time (never module load): a self-hosted deployment
// that never configures GitHub must not crash on boot — the flow simply isn't
// reachable (routes surface GithubOAuthNotConfiguredError as a redirect).

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_API_URL = 'https://api.github.com/user';
const CALLBACK_PATH = '/api/github/oauth/callback';

interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

function resolveConfig(): GithubOAuthConfig {
  const clientId = process.env['GITHUB_APP_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_APP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new GithubOAuthNotConfiguredError();
  return { clientId, clientSecret };
}

/** The redirect_uri GitHub sends the user back to — derived from the canonical
 *  base URL so it matches the value registered on the GitHub App. */
function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

/** The GitHub user fields the identity binding needs. GitHub's `id` is a JSON
 *  number; we carry it as a string (never do math on it). */
interface GithubUser {
  id: number;
  login: string;
  avatar_url?: string | null;
}

export const githubIdentityService = {
  /**
   * Build the GitHub authorize URL for the identity grant. `state` is the
   * caller-minted CSRF nonce the callback re-checks. Throws
   * GithubOAuthNotConfiguredError when the app isn't wired.
   */
  buildAuthorizeUrl(state: string): string {
    const { clientId } = resolveConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', state);
    // Identity-only grant: no `scope` (a GitHub App's user-to-server token
    // carries no OAuth scopes — repo access comes from the installation, not
    // this token). Force a fresh consent so re-connect always re-binds.
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  },

  /**
   * Complete the identity grant: exchange `code` for a user access token, read
   * the GitHub user, encrypt the token, and upsert a `GithubIdentity` bound to
   * `userId` (under `withUserContext`, so RLS binds it to the acting member).
   * Returns the token-free DTO. Throws GithubOAuthNotConfiguredError (unwired)
   * or GithubOAuthExchangeError (exchange / user read failed).
   */
  async completeOAuthCallback(args: { code: string; userId: string }): Promise<GithubIdentityDTO> {
    const { clientId, clientSecret } = resolveConfig();

    const accessToken = await exchangeCodeForToken({
      clientId,
      clientSecret,
      code: args.code,
    });
    const githubUser = await fetchGithubUser(accessToken);

    const accessTokenEncrypted = encryptToken(accessToken);

    const row = await withUserContext(args.userId, (tx) =>
      githubIdentityRepository.upsertForUser(
        {
          userId: args.userId,
          githubUserId: String(githubUser.id),
          githubLogin: githubUser.login,
          avatarUrl: githubUser.avatar_url ?? null,
          accessTokenEncrypted,
        },
        tx,
      ),
    );

    return toGithubIdentityDTO(row);
  },

  /**
   * The acting member's GitHub identity, or null when unbound — the read the
   * settings surface uses. A null result is a valid state (an identity with no
   * installation, or no identity yet), NOT an error.
   */
  async getIdentityForUser(userId: string): Promise<GithubIdentityDTO | null> {
    const row = await withUserContext(userId, (tx) =>
      githubIdentityRepository.findByUserId(userId, tx),
    );
    return row ? toGithubIdentityDTO(row) : null;
  },

  /**
   * The acting member's DECRYPTED GitHub user token, or null when unbound —
   * `getIdentityForUser` (the token-free DTO the surfaces render) with the one
   * field a caller that has to CALL GitHub needs. Same row, same RLS-bound read:
   * a member the settings badge / the import wizard shows as connected is
   * exactly a member this returns a token for, and one it returns null for is
   * exactly the "connect your account" state those surfaces already render.
   *
   * ⚠️ Returns a live credential — callers put it on the wire and never persist,
   * log or echo it. Import's GitHub connector is the second consumer, after
   * `listOrganizations` below (MOTIR-2456).
   *
   * There is nothing to refresh: `GithubIdentity` stores one credential column,
   * `access_token_encrypted` — no `expires_at`, no refresh token — because a
   * GitHub App user-to-server token does not expire unless the App enables
   * "Expire user authorization tokens". Were that ever turned on, the fix is a
   * substrate change HERE (persist an expiry + refresh token), not at a call
   * site (MOTIR-2454 settled this; MOTIR-2456 carried it forward).
   */
  async getLiveToken(userId: string): Promise<{ accessToken: string } | null> {
    const row = await withUserContext(userId, (tx) =>
      githubIdentityRepository.findByUserId(userId, tx),
    );
    if (!row) return null;
    return { accessToken: decryptToken(row.accessTokenEncrypted) };
  },

  /**
   * The organizations the acting member's connected account belongs to (Story
   * MOTIR-1775 · MOTIR-1939) — the takeover picker's "Your organizations" group.
   *
   * ⚠️ A LIVE CALL, because nothing stores them: the identity row holds one
   * login, the PERSONAL one. So this is the only read in the flow that can be
   * slow or fail, and the surface renders both of those as real states.
   *
   * `null` identity → an EMPTY list, never a throw: "no account connected" is
   * answered by the connect prompt the surface already renders for it, not by an
   * error from the organization lookup.
   */
  async listOrganizations(userId: string): Promise<GithubUserOrg[]> {
    const live = await this.getLiveToken(userId);
    if (!live) return [];
    return userOrgsClient.listForToken(live.accessToken);
  },

  /**
   * Unbind the acting member's GitHub identity (Disconnect — MOTIR-895).
   * Independent of the workspace installation — the two grants are independent,
   * so this never touches GithubInstallation (the App is uninstalled on GitHub).
   * Idempotent: disconnecting an already-unbound member is a no-op. Runs under
   * `withUserContext` so RLS narrows the delete to the owner's row.
   */
  async disconnect(userId: string): Promise<void> {
    await withUserContext(userId, (tx) => githubIdentityRepository.deleteByUserId(userId, tx));
  },
};

/** POST the code→token exchange. GitHub returns `application/json` only when
 *  asked; a body without `access_token` (e.g. `{ error: 'bad_verification_code' }`)
 *  is the failure path. Never surfaces GitHub's raw body (it can echo the code). */
async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: callbackUrl(),
      }),
    });
  } catch (err) {
    throw new GithubOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new GithubOAuthExchangeError(`token endpoint returned ${res.status}`);

  let payload: { access_token?: string; error?: string };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new GithubOAuthExchangeError('token endpoint returned a non-JSON body');
  }
  if (!payload.access_token) {
    throw new GithubOAuthExchangeError(
      payload.error ? `token error: ${payload.error}` : 'no access_token in response',
    );
  }
  return payload.access_token;
}

/** Read the authenticated GitHub user for the freshly-minted token. */
async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  let res: Response;
  try {
    res = await fetch(USER_API_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
      },
    });
  } catch (err) {
    throw new GithubOAuthExchangeError(`user endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new GithubOAuthExchangeError(`user endpoint returned ${res.status}`);

  let user: GithubUser;
  try {
    user = (await res.json()) as GithubUser;
  } catch {
    throw new GithubOAuthExchangeError('user endpoint returned a non-JSON body');
  }
  if (typeof user.id !== 'number' || typeof user.login !== 'string') {
    throw new GithubOAuthExchangeError('user endpoint returned an unexpected shape');
  }
  return user;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
