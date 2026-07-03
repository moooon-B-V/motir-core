import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { toGithubInstallationDTO } from '@/lib/mappers/githubMappers';
import { getGitProvider } from '@/lib/git';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import type { GitProviderId, InstallationToken, NormalizedRepo } from '@/lib/git/types';

// GitHub App installation service (Story 7.10 · MOTIR-891) — "Grant 2". Owns the
// business logic + transactions for persisting an installation and its selected
// repos, reading a workspace's installation, and minting its short-lived access
// token THROUGH the GitProvider seam. The two grants are independent: this
// service never touches GithubIdentity, and a workspace with an installation but
// no member identity (or vice-versa) is a valid, crash-free state.
//
// Context by path (CLAUDE.md 4-layer + the RLS model):
//   * the WRITE path is the `installation` webhook (MOTIR-892), which has no
//     active workspace — it runs under `withSystemContext` (the trusted-writer
//     escape the RLS policy admits);
//   * the READ + token paths are tenant requests — they run under
//     `withWorkspaceContext`, so the workspace RLS gate scopes them.

export const githubInstallationService = {
  /**
   * Persist an installation and reconcile its selected repos (WRITE path — the
   * webhook, system context). Input is already normalized through the provider
   * seam (`NormalizedRepo[]`). Upserts the installation, upserts each selected
   * repo, then deletes any repo no longer selected. Returns the token-free DTO.
   */
  async persistInstallation(input: {
    workspaceId: string;
    installation: { installationId: string; accountLogin: string; accountType: string };
    repos: NormalizedRepo[];
  }): Promise<GithubInstallationDTO> {
    return withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.upsert(
        {
          installationId: input.installation.installationId,
          workspaceId: input.workspaceId,
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
        },
        tx,
      );

      for (const repo of input.repos) {
        await githubRepoRepository.upsert(
          {
            installationId: installation.id,
            repoId: repo.providerRepoId,
            owner: repo.owner,
            name: repo.name,
            defaultBranch: repo.defaultBranch,
          },
          tx,
        );
      }
      await githubRepoRepository.deleteExcept(
        installation.id,
        input.repos.map((repo) => repo.providerRepoId),
        tx,
      );

      const repos = await githubRepoRepository.listByInstallation(installation.id, tx);
      return toGithubInstallationDTO(installation, repos);
    });
  },

  /**
   * The workspace's installation + its selected repos, or null when the
   * workspace has no installation (a valid "not connected" state the UI shows —
   * it does NOT require a bound member identity). READ path, workspace context.
   */
  async getWorkspaceInstallation(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<GithubInstallationDTO | null> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const installation = await githubInstallationRepository.findByWorkspaceId(
          ctx.workspaceId,
          tx,
        );
        if (!installation) return null;
        const repos = await githubRepoRepository.listByInstallation(installation.id, tx);
        return toGithubInstallationDTO(installation, repos);
      },
    );
  },

  /**
   * Mint a short-lived installation access token for the workspace's
   * installation, dispatched THROUGH the provider seam by the stored `provider`
   * discriminator (so GitLab would work with no change here). Never persists the
   * token. Returns null when the workspace has no installation.
   */
  async mintAccessTokenForWorkspace(ctx: {
    userId: string;
    workspaceId: string;
  }): Promise<InstallationToken | null> {
    const installation = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => githubInstallationRepository.findByWorkspaceId(ctx.workspaceId, tx),
    );
    if (!installation) return null;
    const provider = getGitProvider(installation.provider as GitProviderId);
    return provider.mintInstallationToken(installation.installationId);
  },
};
