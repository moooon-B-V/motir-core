import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { toGithubInstallationDTO } from '@/lib/mappers/githubMappers';
import { encryptToken, decryptToken } from '@/lib/gitlab/tokenCrypto';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGitlabUser,
  refreshAccessToken,
} from '@/lib/gitlab/gitlabOAuth';
import { getGitProvider } from '@/lib/git';
import { enqueueCodeGraphIndex } from '@/lib/github/indexEnqueue';
import { GitlabConnectionNotFoundError, GitlabProjectNotFoundError } from '@/lib/gitlab/errors';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import type { GitlabSelectableProjectDTO } from '@/lib/dto/gitlab';
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
   * The workspace's GitLab connection (token-free DTO) WITH its connected projects
   * (`github_repo` rows under the connection), or null when unconnected — the read
   * the settings surface (7.23.7 / MOTIR-1478) renders. Workspace context; the
   * connection row + its repos are read in ONE transaction so the settings page
   * shows a consistent snapshot.
   */
  async getConnectionForWorkspace(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<GithubInstallationDTO | null> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const row = await githubInstallationRepository.findByWorkspaceAndProvider(
          ctx.workspaceId,
          'gitlab',
          tx,
        );
        if (!row) return null;
        const repos = await githubRepoRepository.listByInstallation(row.id, tx);
        return toGithubInstallationDTO(row, repos);
      },
    );
  },

  /**
   * List the authenticated user's GitLab projects for the in-app picker (Panel 2b,
   * MOTIR-1478) — the honest inverse of GitHub's out-of-app install screen. Reads
   * the connection + its already-connected repo ids (workspace context), then
   * live-enumerates the user's projects through the GitProvider seam (the stored
   * token, refreshed as needed) and marks which are already connected. Throws
   * GitlabConnectionNotFoundError when the workspace has no GitLab connection; a
   * live-enumeration failure (a revoked authorization) propagates as the seam's
   * error for the caller to surface as "reconnect".
   */
  async listSelectableProjects(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<GitlabSelectableProjectDTO[]> {
    const conn = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const row = await githubInstallationRepository.findByWorkspaceAndProvider(
          ctx.workspaceId,
          'gitlab',
          tx,
        );
        if (!row) throw new GitlabConnectionNotFoundError();
        const repos = await githubRepoRepository.listByInstallation(row.id, tx);
        return {
          installationId: row.installationId,
          connectedIds: new Set(repos.map((r) => r.repoId)),
        };
      },
    );

    const projects = await getGitProvider('gitlab').fetchInstallationRepos(conn.installationId);
    return projects.map((p) => ({
      repoId: p.providerRepoId,
      owner: p.owner,
      name: p.name,
      defaultBranch: p.defaultBranch,
      connected: conn.connectedIds.has(p.providerRepoId),
    }));
  },

  /**
   * Connect a GitLab project to the workspace (MOTIR-1478) — persist the selection
   * as a `github_repo` row under the GitLab connection. The project's owner / name
   * / default branch are resolved from GitLab's AUTHORITATIVE membership list (not
   * the client's payload), so a stale picker row or an id the user has no access
   * to is rejected (GitlabProjectNotFoundError) rather than stored as an
   * unreachable row. Idempotent (upsert). Throws GitlabConnectionNotFoundError
   * when the workspace is unconnected. (The MR/pipeline webhook that makes the
   * project's events flow is registered by MOTIR-1475; this card owns the
   * selection.)
   *
   * CODE-GRAPH FEED — "full on first connect" (MOTIR-1476): a NEWLY-connected
   * project (no `github_repo` row existed yet) kicks a full `system.code-graph-index`
   * job — the GitLab analogue of GitHub's `enqueueNewlyAddedRepos`, driving the SAME
   * provider-agnostic indexer (`codeGraphIndexService` fetches via the stored
   * `provider`). Enqueued POST-COMMIT + best-effort (the enqueue swallows + logs a
   * transport failure), so a GitLab/queue blip can never fail or roll back the
   * selection write (the side-effects-outside-tx rule); the index job is idempotent,
   * so a dropped enqueue self-heals on the next connect / manual replay. A
   * RE-connect of an already-connected project does NOT re-index (only the newly
   * added one), exactly as the GitHub reconcile diffs against the existing set.
   */
  async connectProject(
    ctx: { userId: string; workspaceId: string },
    repoId: string,
  ): Promise<void> {
    const conn = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        githubInstallationRepository.findByWorkspaceAndProvider(ctx.workspaceId, 'gitlab', tx),
    );
    if (!conn) throw new GitlabConnectionNotFoundError();

    const projects = await getGitProvider('gitlab').fetchInstallationRepos(conn.installationId);
    const match = projects.find((p) => p.providerRepoId === repoId);
    if (!match) throw new GitlabProjectNotFoundError();

    // Persist the selection, reporting whether this was a NEWLY-added repo (no row
    // before) so only a first connect — not a re-connect — triggers a full index.
    const isNewlyConnected = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const existing = await githubRepoRepository.findByInstallationAndRepoId(
          conn.id,
          match.providerRepoId,
          tx,
        );
        await githubRepoRepository.upsert(
          {
            installationId: conn.id,
            repoId: match.providerRepoId,
            owner: match.owner,
            name: match.name,
            defaultBranch: match.defaultBranch,
            provider: 'gitlab',
          },
          tx,
        );
        return existing === null;
      },
    );

    // POST-COMMIT, best-effort full code-graph index for a first-time connect
    // (MOTIR-1476). `conn.installationId` is the synthetic GitLab connection id the
    // index job resolves back to this connection (provider `gitlab`) to mint the
    // token + fetch the repo through the provider seam.
    if (isNewlyConnected) {
      await enqueueCodeGraphIndex({
        installationId: conn.installationId,
        workspaceId: ctx.workspaceId,
        repoOwner: match.owner,
        repoName: match.name,
        defaultBranch: match.defaultBranch,
      });
    }
  },

  /**
   * Disconnect a GitLab project from the workspace (MOTIR-1478) — remove its
   * `github_repo` row. Idempotent (a no-op when the project or connection is
   * already gone). Workspace context; the row's `github_pull_request` rows cascade.
   */
  async disconnectProject(
    ctx: { userId: string; workspaceId: string },
    repoId: string,
  ): Promise<void> {
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      const conn = await githubInstallationRepository.findByWorkspaceAndProvider(
        ctx.workspaceId,
        'gitlab',
        tx,
      );
      if (!conn) return;
      await githubRepoRepository.deleteByInstallationAndRepoId(conn.id, repoId, tx);
    });
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
