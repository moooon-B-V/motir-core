import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { toGithubInstallationDTO } from '@/lib/mappers/githubMappers';
import { encryptToken, decryptToken } from '@/lib/gitlab/tokenCrypto';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGitlabUser,
  refreshAccessToken,
} from '@/lib/gitlab/gitlabOAuth';
import { GitlabConnectionNotFoundError } from '@/lib/gitlab/errors';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import type { InstallationToken } from '@/lib/git/types';

// GitLab connection service (Story 7.23 · MOTIR-1474) — the GitLab half of the
// GitProvider seam's connect + token layer. Owns the OAuth orchestration (build
// authorize URL, code→token exchange, the `GET /user` bind), token encryption,
// and the transactional token store + refresh. GitLab connections are the SHARED
// `GithubInstallation` entity under `provider: 'gitlab'` (the card's "no new
// parallel model"); the routes are HTTP-only.
//
// UNLIKE GitHub (which mints installation tokens on demand from an App key and
// stores nothing), GitLab's OAuth grant issues an access + refresh token per
// connection that we PERSIST (encrypted) and refresh. GitLab ROTATES the refresh
// token on every refresh, so a refresh MUST be serialized against concurrent
// mints — `getAccessToken` holds a FOR UPDATE row lock across the refresh so two
// callers can't both spend the same (single-use) refresh token.

// Re-mint this many ms BEFORE the reported expiry so an in-flight call never
// races the boundary (GitLab access tokens last ~2h; a 60s skew is ample).
const EXPIRY_SKEW_MS = 60_000;

/** The synthetic, stable connection id for a workspace's GitLab connection. GitLab
 *  has no host "installation id", so we derive one from the workspace — unique
 *  (workspace ids are unique) and stable across re-connects (the upsert refreshes
 *  the same row rather than creating a duplicate). */
function connectionId(workspaceId: string): string {
  return `gitlab-ws-${workspaceId}`;
}

export const gitlabConnectionService = {
  /**
   * Build the GitLab authorize URL for the connect grant. `state` is the caller-
   * minted signed CSRF state the callback re-checks. Throws
   * GitlabOAuthNotConfiguredError when the app isn't wired.
   */
  buildAuthorizeUrl(state: string): string {
    return buildAuthorizeUrl(state);
  },

  /**
   * Complete the connect grant: exchange `code` for the access + refresh token
   * set, read the GitLab user, encrypt both tokens, and upsert the workspace's
   * GitLab connection (under `withWorkspaceContext`, so RLS binds it to the
   * workspace). Returns the token-free DTO. Throws GitlabOAuthNotConfiguredError
   * (unwired) or GitlabOAuthExchangeError (exchange / user read failed).
   */
  async completeOAuthCallback(args: {
    code: string;
    workspaceId: string;
    userId: string;
  }): Promise<GithubInstallationDTO> {
    const tokens = await exchangeCodeForToken(args.code);
    const gitlabUser = await fetchGitlabUser(tokens.accessToken);

    const row = await withWorkspaceContext(
      { userId: args.userId, workspaceId: args.workspaceId },
      (tx) =>
        githubInstallationRepository.upsertGitlabConnection(
          {
            installationId: connectionId(args.workspaceId),
            workspaceId: args.workspaceId,
            accountLogin: gitlabUser.username,
            accountType: 'User',
            accessTokenEncrypted: encryptToken(tokens.accessToken),
            refreshTokenEncrypted: encryptToken(tokens.refreshToken),
            tokenExpiresAt: tokens.expiresAt,
          },
          tx,
        ),
    );

    return toGithubInstallationDTO(row, []);
  },

  /**
   * Return a valid access token for a GitLab connection, refreshing (and
   * persisting the ROTATED token set) when the stored one is at/near expiry. The
   * GitProvider seam's `mintInstallationToken` for GitLab. System context (a
   * token mint is a trusted, cross-workspace operation, like the GitHub webhook
   * writer). The FOR UPDATE lock is held ACROSS the refresh HTTP call on purpose:
   * GitLab invalidates the old refresh token on rotation, so a concurrent caller
   * must block until we persist the new set, then re-read the fresh token — never
   * spend the same refresh token twice. A degraded GitLab surfaces as a clean
   * transaction abort, never a corrupted/half-rotated token.
   */
  async getAccessToken(installationId: string): Promise<InstallationToken> {
    return withSystemContext(async (tx) => {
      await githubInstallationRepository.lockByInstallationId(installationId, tx);
      const conn = await githubInstallationRepository.findByInstallationId(installationId, tx);
      if (
        !conn ||
        conn.provider !== 'gitlab' ||
        !conn.accessTokenEncrypted ||
        !conn.refreshTokenEncrypted
      ) {
        throw new GitlabConnectionNotFoundError();
      }

      // Still-valid stored token → return it (the common path; no refresh).
      if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
        return { token: decryptToken(conn.accessTokenEncrypted), expiresAt: conn.tokenExpiresAt };
      }

      // Expired/near-expiry → refresh under the lock and persist the rotated set.
      const refreshed = await refreshAccessToken(decryptToken(conn.refreshTokenEncrypted));
      const updated = await githubInstallationRepository.updateTokens(
        conn.id,
        {
          accessTokenEncrypted: encryptToken(refreshed.accessToken),
          refreshTokenEncrypted: encryptToken(refreshed.refreshToken),
          tokenExpiresAt: refreshed.expiresAt,
        },
        tx,
      );
      return {
        token: refreshed.accessToken,
        expiresAt: updated.tokenExpiresAt ?? refreshed.expiresAt,
      };
    });
  },

  /**
   * The workspace's GitLab connection (token-free DTO), or null when unconnected —
   * the read a settings surface (7.23.7) uses. Workspace context.
   */
  async getConnectionForWorkspace(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<GithubInstallationDTO | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        githubInstallationRepository.findByWorkspaceAndProvider(ctx.workspaceId, 'gitlab', tx),
    );
    return row ? toGithubInstallationDTO(row, []) : null;
  },

  /**
   * Disconnect the workspace's GitLab connection (idempotent — a no-op when
   * unconnected). Workspace context. Cascades to any GitLab repo/MR rows via the
   * FK `onDelete: Cascade`.
   */
  async disconnect(ctx: { userId: string; workspaceId: string }): Promise<void> {
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      const conn = await githubInstallationRepository.findByWorkspaceAndProvider(
        ctx.workspaceId,
        'gitlab',
        tx,
      );
      if (conn) await githubInstallationRepository.deleteByInstallationId(conn.installationId, tx);
    });
  },
};
