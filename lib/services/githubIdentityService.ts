import { withUserContext } from '@/lib/workspaces/context';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { toGithubIdentityDTO } from '@/lib/mappers/githubMappers';
import { encryptToken, decryptToken } from '@/lib/github/tokenCrypto';
import { userOrgsClient, type GithubUserOrg } from '@/lib/github/userOrgs';
import {
  GithubIdentityExpiredError,
  GithubIdentityNotLinkedError,
  GithubOAuthExchangeError,
  GithubOAuthNotConfiguredError,
} from '@/lib/github/errors';
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

/** Refresh when the token has less than this left (MOTIR-6519), so a caller
 *  never hands out a token that dies in the middle of the push it was minted
 *  for. */
const REFRESH_MARGIN_MS = 10 * 60_000;

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

/** What GitHub's token endpoint answers. `expires_in` and the refresh fields are
 *  present only when the App expires its user tokens (MOTIR-6519). */
interface TokenPayload {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

/** One issue of tokens — a code exchange or a refresh. The expiries and the
 *  refresh token are null for a non-expiring token. */
interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
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
   * When the App expires its user tokens, the refresh token and both expiries
   * are stored too (MOTIR-6519); a non-expiring token stores them as null, which
   * also clears a stale pair on a re-link.
   * Returns the token-free DTO. Throws GithubOAuthNotConfiguredError (unwired)
   * or GithubOAuthExchangeError (exchange / user read failed).
   */
  async completeOAuthCallback(args: { code: string; userId: string }): Promise<GithubIdentityDTO> {
    const config = resolveConfig();

    const issued = await requestTokens(config, {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: callbackUrl(),
    });
    const githubUser = await fetchGithubUser(issued.accessToken);

    const row = await withUserContext(args.userId, (tx) =>
      githubIdentityRepository.upsertForUser(
        {
          userId: args.userId,
          githubUserId: String(githubUser.id),
          githubLogin: githubUser.login,
          avatarUrl: githubUser.avatar_url ?? null,
          ...encryptIssued(issued),
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
   * A VALID GitHub user token for `userId` (MOTIR-6519) — refreshed first when
   * it expires within the margin.
   *
   * ⚠️ Returns a live credential: callers put it on the wire and never persist,
   * log or echo it.
   *
   * A non-expiring token (no `accessTokenExpiresAt` — an identity linked before
   * the App turned on "Expire user authorization tokens") is returned as it is.
   *
   * The refresh runs INSIDE the row-locked transaction, a deliberate exception
   * to side-effects-outside-the-transaction: GitHub ROTATES the refresh token on
   * every use, so the call and the save of its result must be one serial step
   * per member. Two callers racing with the same refresh token would otherwise
   * leave the loser holding a dead one; under the lock the second caller reads
   * the pair the first persisted, and GitHub is called once. The lock is per
   * member, and a refresh is one HTTP round trip.
   *
   * Throws GithubIdentityNotLinkedError (no identity), GithubIdentityExpiredError
   * (the refresh token is gone, expired, or GitHub refused it — then the row is
   * marked expired so the next read does not spend it again), and — only when a
   * refresh is actually needed — GithubOAuthNotConfiguredError or a transport
   * GithubOAuthExchangeError.
   */
  async getUserToken(
    userId: string,
  ): Promise<{ accessToken: string; githubLogin: string; githubUserId: string }> {
    const outcome = await withUserContext(userId, async (tx) => {
      const row = await githubIdentityRepository.findByUserIdForUpdate(userId, tx);
      if (!row) return { kind: 'not_linked' as const };
      const now = new Date();
      const accessLive =
        row.accessTokenExpiresAt === null ||
        row.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
      if (accessLive) {
        return { kind: 'token' as const, accessToken: decryptToken(row.accessTokenEncrypted), row };
      }
      const refreshLive =
        row.refreshTokenEncrypted !== null &&
        (row.refreshTokenExpiresAt === null || row.refreshTokenExpiresAt > now);
      if (!refreshLive) {
        return { kind: 'expired' as const, detail: 'the refresh token has expired' };
      }
      let issued: IssuedTokens;
      try {
        issued = await requestTokens(resolveConfig(), {
          grant_type: 'refresh_token',
          refresh_token: decryptToken(row.refreshTokenEncrypted as string),
        });
      } catch (err) {
        // GitHub answered, and the answer was no (`bad_refresh_token`): the pair
        // is dead. A transport failure is NOT that — it rethrows, and the row
        // stays as it was for the next attempt.
        if (err instanceof GithubOAuthExchangeError && err.message.includes('token error:')) {
          await githubIdentityRepository.markTokensExpired(userId, now, tx);
          return { kind: 'expired' as const, detail: 'GitHub refused the refresh token' };
        }
        throw err;
      }
      const saved = await githubIdentityRepository.updateTokens(userId, encryptIssued(issued), tx);
      return { kind: 'token' as const, accessToken: issued.accessToken, row: saved };
    });
    if (outcome.kind === 'not_linked') throw new GithubIdentityNotLinkedError();
    if (outcome.kind === 'expired') throw new GithubIdentityExpiredError(outcome.detail);
    return {
      accessToken: outcome.accessToken,
      githubLogin: outcome.row.githubLogin,
      githubUserId: outcome.row.githubUserId,
    };
  },

  /**
   * The acting member's valid GitHub user token, or null when there is none to
   * give — `getUserToken` in the shape Import's GitHub connector (MOTIR-2456)
   * and `listOrganizations` below already consume. Null covers BOTH "never
   * connected" and "connected, but the token can no longer be renewed", because
   * both have the same remedy — connect again — and those surfaces already
   * render that state for null.
   *
   * ⚠️ Returns a live credential — callers put it on the wire and never persist,
   * log or echo it.
   */
  async getLiveToken(userId: string): Promise<{ accessToken: string } | null> {
    try {
      const { accessToken } = await this.getUserToken(userId);
      return { accessToken };
    } catch (err) {
      if (
        err instanceof GithubIdentityNotLinkedError ||
        err instanceof GithubIdentityExpiredError
      ) {
        return null;
      }
      throw err;
    }
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
   * Unbind the acting member's GitHub identity (Disconnect — MOTIR-895), then
   * revoke its token at GitHub (`DELETE /applications/{client_id}/token` —
   * MOTIR-6519, now that the token can write code).
   * Independent of the workspace installation — the two grants are independent,
   * so this never touches GithubInstallation (the App is uninstalled on GitHub).
   * Idempotent: disconnecting an already-unbound member is a no-op. The delete
   * runs under `withUserContext` so RLS narrows it to the owner's row.
   *
   * The delete is the promise and commits FIRST; the revoke is best-effort —
   * a failure (or an unconfigured App) is logged, never thrown: the row is gone
   * either way, and an expiring token dies on its own clock.
   */
  async disconnect(userId: string): Promise<void> {
    const removed = await withUserContext(userId, async (tx) => {
      const row = await githubIdentityRepository.findByUserId(userId, tx);
      if (!row) return null;
      await githubIdentityRepository.deleteByUserId(userId, tx);
      return row;
    });
    if (!removed) return;
    await revokeToken(decryptToken(removed.accessTokenEncrypted));
  },
};

function encryptIssued(issued: IssuedTokens) {
  return {
    accessTokenEncrypted: encryptToken(issued.accessToken),
    accessTokenExpiresAt: issued.accessTokenExpiresAt,
    refreshTokenEncrypted: issued.refreshToken ? encryptToken(issued.refreshToken) : null,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
  };
}

/** POST the token endpoint — the code exchange, or a refresh (MOTIR-6519).
 *  GitHub returns `application/json` only when asked; a body without
 *  `access_token` (`{ error: 'bad_verification_code' }`, `{ error:
 *  'bad_refresh_token' }`) is a refusal, reported as `token error: <code>`.
 *  Never surfaces GitHub's raw body (it can echo the code). */
async function requestTokens(
  config: GithubOAuthConfig,
  grant: Record<string, string>,
): Promise<IssuedTokens> {
  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...grant,
      }),
    });
  } catch (err) {
    throw new GithubOAuthExchangeError(`token endpoint unreachable (${describeError(err)})`);
  }
  if (!res.ok) throw new GithubOAuthExchangeError(`token endpoint returned ${res.status}`);

  let payload: TokenPayload;
  try {
    payload = (await res.json()) as TokenPayload;
  } catch {
    throw new GithubOAuthExchangeError('token endpoint returned a non-JSON body');
  }
  if (!payload.access_token) {
    throw new GithubOAuthExchangeError(
      payload.error ? `token error: ${payload.error}` : 'no access_token in response',
    );
  }
  const now = Date.now();
  return {
    accessToken: payload.access_token,
    accessTokenExpiresAt:
      typeof payload.expires_in === 'number' ? new Date(now + payload.expires_in * 1000) : null,
    refreshToken: payload.refresh_token ?? null,
    refreshTokenExpiresAt:
      typeof payload.refresh_token_expires_in === 'number'
        ? new Date(now + payload.refresh_token_expires_in * 1000)
        : null,
  };
}

/** Revoke one user token at GitHub (`DELETE /applications/{client_id}/token`,
 *  basic-authenticated as the App). Best-effort: every failure is logged and
 *  swallowed — a 404 means GitHub already forgot it (expired, or revoked by the
 *  person), which is the outcome we wanted. */
async function revokeToken(accessToken: string): Promise<void> {
  const clientId = process.env['GITHUB_APP_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_APP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    console.warn('[githubIdentityService] GitHub App not configured; token not revoked');
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/applications/${clientId}/token`, {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'motir',
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(
        `[githubIdentityService] token revoke answered ${res.status}; the row is deleted`,
      );
    }
  } catch (err) {
    console.warn(
      `[githubIdentityService] token revoke failed (${describeError(err)}); the row is deleted`,
    );
  }
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
