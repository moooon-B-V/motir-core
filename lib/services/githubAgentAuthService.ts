import { withUserContext } from '@/lib/workspaces/context';
import { githubAgentAuthorizationRepository } from '@/lib/repositories/githubAgentAuthorizationRepository';
import { toGithubAgentLinkStatusDTO } from '@/lib/mappers/githubMappers';
import { encryptToken, decryptToken } from '@/lib/github/tokenCrypto';
import {
  GithubAgentAppNotConfiguredError,
  GithubAgentAuthorizationExpiredError,
  GithubAgentNotLinkedError,
  GithubOAuthExchangeError,
} from '@/lib/github/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { GithubAgentLinkStatusDTO } from '@/lib/dto/github';

// The Motir Agent authorization service (Story MOTIR-683 · MOTIR-6519).
//
// A person links their GitHub account to the MOTIR AGENT app — the opt-in
// writer App (MOTIR-1894) — so a hosted run on a repository THEY own pushes and
// opens its pull request as them (`docs/decisions/hosted-agent-run.md` §4). It
// mirrors `githubIdentityService` (MOTIR-1498) step for step, with two
// differences that are the reason it is a separate service over a separate
// table:
//
//   · A GitHub user token belongs to the App that issued it, so the Motir
//     Integration identity cannot stand in for this one.
//   · This App EXPIRES its user tokens (8 h) and issues a refresh token
//     (≈6 months) that ROTATES on every use. So `getUserToken` refreshes under a
//     row lock: two concurrent refreshes with one refresh token would leave the
//     loser holding a dead token.
//
// Config is read at CALL time: a deployment without the App cannot reach the
// flow, and nothing crashes on boot.

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_API_URL = 'https://api.github.com/user';
const CALLBACK_PATH = '/api/github/agent/oauth/callback';

/** Refresh when the token has less than this left, so a caller never hands out
 *  a token that dies in the middle of the git push it was minted for. */
const REFRESH_MARGIN_MS = 10 * 60_000;

interface AgentAppConfig {
  clientId: string;
  clientSecret: string;
}

function resolveConfig(): AgentAppConfig {
  const clientId = process.env['GITHUB_AGENT_APP_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_AGENT_APP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new GithubAgentAppNotConfiguredError();
  return { clientId, clientSecret };
}

function isConfigured(): boolean {
  return Boolean(
    process.env['GITHUB_AGENT_APP_CLIENT_ID'] && process.env['GITHUB_AGENT_APP_CLIENT_SECRET'],
  );
}

/** The redirect_uri registered on the App (MOTIR-1894): `<base>/api/github/agent/oauth/callback`. */
function callbackUrl(): string {
  return `${resolveBaseUrlTrimmed()}${CALLBACK_PATH}`;
}

/** What GitHub's token endpoint answers for an expiring user token. */
interface TokenPayload {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export const githubAgentAuthService = {
  /** The GitHub authorize URL for the Motir Agent link. `state` is the
   *  caller-minted CSRF nonce the callback re-checks. */
  buildAuthorizeUrl(state: string): string {
    const { clientId } = resolveConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl());
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  },

  /**
   * Complete the link: exchange `code`, read the GitHub user, and store BOTH
   * tokens encrypted for `userId` (a re-link replaces the row). Throws
   * GithubAgentAppNotConfiguredError or GithubOAuthExchangeError.
   */
  async completeOAuthCallback(args: {
    code: string;
    userId: string;
  }): Promise<GithubAgentLinkStatusDTO> {
    const config = resolveConfig();
    const issued = await requestTokens(config, {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: callbackUrl(),
    });
    const user = await fetchGithubUser(issued.accessToken);
    const row = await withUserContext(args.userId, (tx) =>
      githubAgentAuthorizationRepository.upsertForUser(
        {
          userId: args.userId,
          githubUserId: String(user.id),
          githubLogin: user.login,
          ...encryptIssued(issued),
        },
        tx,
      ),
    );
    return toGithubAgentLinkStatusDTO(row, new Date());
  },

  /** The member's link state, for the account surface. Never throws for a
   *  missing configuration — that is a state the surface draws. */
  async getLinkStatus(userId: string): Promise<GithubAgentLinkStatusDTO> {
    if (!isConfigured()) return { state: 'not_configured' };
    const row = await withUserContext(userId, (tx) =>
      githubAgentAuthorizationRepository.findByUserId(userId, tx),
    );
    return toGithubAgentLinkStatusDTO(row, new Date());
  },

  /**
   * A LIVE Motir Agent user token for `userId`, refreshed first when it expires
   * within the margin — the read MOTIR-6449 narrows to one repository for a run.
   *
   * ⚠️ Returns a live credential: callers put it on the wire and never persist,
   * log or echo it.
   *
   * The refresh runs INSIDE the locked transaction, which is a deliberate
   * exception to side-effects-outside-the-transaction: the refresh token rotates
   * on use, so the call and the write of its result must be one serial unit per
   * user. The lock is per member, and a refresh is one HTTP round trip.
   *
   * Throws GithubAgentAppNotConfiguredError, GithubAgentNotLinkedError, or
   * GithubAgentAuthorizationExpiredError (no usable refresh token, or GitHub
   * refused it — then the row is marked expired so the surface says so).
   */
  async getUserToken(
    userId: string,
  ): Promise<{ accessToken: string; githubLogin: string; githubUserId: string }> {
    const config = resolveConfig();
    const outcome = await withUserContext(userId, async (tx) => {
      const row = await githubAgentAuthorizationRepository.findByUserIdForUpdate(userId, tx);
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
      if (!refreshLive)
        return { kind: 'expired' as const, detail: 'the refresh token has expired' };
      let issued: IssuedTokens;
      try {
        issued = await requestTokens(config, {
          grant_type: 'refresh_token',
          refresh_token: decryptToken(row.refreshTokenEncrypted as string),
        });
      } catch (err) {
        if (err instanceof GithubOAuthExchangeError && err.message.includes('token error:')) {
          await githubAgentAuthorizationRepository.markRefreshExpired(userId, now, tx);
          return { kind: 'expired' as const, detail: 'GitHub refused the refresh token' };
        }
        throw err;
      }
      const saved = await githubAgentAuthorizationRepository.updateTokens(
        userId,
        encryptIssued(issued),
        tx,
      );
      return { kind: 'token' as const, accessToken: issued.accessToken, row: saved };
    });
    if (outcome.kind === 'not_linked') throw new GithubAgentNotLinkedError();
    if (outcome.kind === 'expired') throw new GithubAgentAuthorizationExpiredError(outcome.detail);
    return {
      accessToken: outcome.accessToken,
      githubLogin: outcome.row.githubLogin,
      githubUserId: outcome.row.githubUserId,
    };
  },

  /**
   * Unlink: delete the member's authorization, then revoke the token at GitHub
   * (`DELETE /applications/{client_id}/token`). The delete is the promise and
   * is committed first; a revoke that fails is logged, never thrown — the row is
   * gone either way, and the token dies on its own 8-hour clock. Idempotent.
   */
  async unlink(userId: string): Promise<{ unlinked: boolean }> {
    const config = resolveConfig();
    const removed = await withUserContext(userId, async (tx) => {
      const row = await githubAgentAuthorizationRepository.findByUserId(userId, tx);
      if (!row) return null;
      await githubAgentAuthorizationRepository.deleteByUserId(userId, tx);
      return row;
    });
    if (!removed) return { unlinked: false };
    try {
      const res = await fetch(`https://api.github.com/applications/${config.clientId}/token`, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'motir',
        },
        body: JSON.stringify({ access_token: decryptToken(removed.accessTokenEncrypted) }),
      });
      if (!res.ok && res.status !== 404) {
        console.warn(
          `[githubAgentAuthService] token revoke answered ${res.status}; the row is deleted`,
        );
      }
    } catch (err) {
      console.warn(
        `[githubAgentAuthService] token revoke failed (${describeError(err)}); the row is deleted`,
      );
    }
    return { unlinked: true };
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

/** POST the token endpoint (a code exchange or a refresh). A body without
 *  `access_token` — `{ error: 'bad_refresh_token' }` — is a refusal, reported as
 *  `token error: <code>`; GitHub's raw body is never surfaced. */
async function requestTokens(
  config: AgentAppConfig,
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

async function fetchGithubUser(accessToken: string): Promise<{ id: number; login: string }> {
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
  let user: { id?: unknown; login?: unknown };
  try {
    user = (await res.json()) as typeof user;
  } catch {
    throw new GithubOAuthExchangeError('user endpoint returned a non-JSON body');
  }
  if (typeof user.id !== 'number' || typeof user.login !== 'string') {
    throw new GithubOAuthExchangeError('user endpoint returned an unexpected shape');
  }
  return { id: user.id, login: user.login };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
