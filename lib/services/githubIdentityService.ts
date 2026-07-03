import { withUserContext } from '@/lib/workspaces/context';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { toGithubIdentityDTO } from '@/lib/mappers/githubMappers';
import { encryptToken } from '@/lib/github/tokenCrypto';
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
