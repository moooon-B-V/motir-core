import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { toGithubInstallationDTO } from '@/lib/mappers/githubMappers';
import { getGitProvider } from '@/lib/git';
import { enqueueNewlyAddedRepos } from '@/lib/github/indexEnqueue';
import type { GithubRepo } from '@prisma/client';
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
   *
   * THE USER-INSTALLATION PATH ONLY (MOTIR-1931). `workspaceId` is a required
   * `string`, and a shared provisioning installation has none — so this method,
   * and with it the destructive `deleteExcept` prune, cannot be called for one.
   * That is deliberate: `fetchInstallationRepos` returns EVERY tenant's repos for
   * a shared installation, so a reconcile here would both delete the repos it did
   * not fetch and leak the ones it did. Motir-created repos are persisted one row
   * at a time by the creation primitive (MOTIR-1781), never reconciled.
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
            // The repo's OWN tenancy (MOTIR-1931) — the same workspace this
            // installation is bound to, since this path only ever runs for a
            // workspace's own grant.
            workspaceId: input.workspaceId,
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
   * Mirror ONE repository Motir just CREATED in its provisioning org (Story
   * MOTIR-1775 · MOTIR-1781) — the whole write, and deliberately not a reconcile.
   *
   * Two facts make this a separate method rather than a `persistInstallation`
   * call with one repo:
   *
   *   1. **The installation is SHARED and belongs to no tenant** (MOTIR-1931 /
   *      the ADR's 2026-07-31 amendment §3). It is upserted with
   *      `workspaceId: null`; the REPO row carries the creating project's
   *      workspace, which is what every tenancy read now resolves through.
   *   2. **Nothing may prune.** `persistInstallation` reconciles the whole
   *      selection and would call `deleteExcept` — on a shared installation that
   *      deletes every OTHER tenant's created repos. This writes exactly the one
   *      row and touches nothing else, so `deleteExcept` stays unreachable on
   *      this path as a property of the code, not as a caution.
   *
   * There is also NO webhook to wait for: GitHub fires no
   * `installation_repositories` delivery for a repo the App itself creates on an
   * all-repositories install (spike Mechanic 2), which is exactly why the
   * creation flow drives this in-flow. Returns the mirrored row.
   *
   * System context — like every other installation write, this runs with no
   * active workspace (the acting caller's own workspace gates the row it is
   * about, one layer up, in `projectRepoProvisioningService`).
   */
  async persistProvisionedRepo(input: {
    /** The tenant the REPOSITORY belongs to — stamped on the repo row. */
    workspaceId: string;
    installation: { installationId: string; accountLogin: string; accountType: string };
    repo: NormalizedRepo;
  }): Promise<GithubRepo> {
    return withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.upsert(
        {
          installationId: input.installation.installationId,
          // NULL, always: Motir's provisioning installation serves N workspaces
          // and is owned by none of them.
          workspaceId: null,
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
        },
        tx,
      );
      return githubRepoRepository.upsert(
        {
          installationId: installation.id,
          workspaceId: input.workspaceId,
          repoId: input.repo.providerRepoId,
          owner: input.repo.owner,
          name: input.repo.name,
          defaultBranch: input.repo.defaultBranch,
        },
        tx,
      );
    });
  },

  /**
   * BIND a fresh App installation to a workspace (MOTIR-1588) — the post-install
   * setup flow's landing. The webhook (MOTIR-892) only RECONCILES an
   * already-bound installation; this creates the first binding. Given only the
   * host `installationId` (from GitHub's post-install redirect), it fetches the
   * installation's account + selected repos through the provider seam (App JWT →
   * installation token) and upserts them for `workspaceId` via
   * `persistInstallation`. The CALLER (the setup route) is responsible for
   * authorizing that the acting user may bind to `workspaceId`. Idempotent — a
   * re-install / repo-selection change refreshes the same rows in place.
   */
  async bindInstallationForWorkspace(ctx: {
    workspaceId: string;
    installationId: string;
    provider?: GitProviderId;
  }): Promise<GithubInstallationDTO> {
    const gitProvider = getGitProvider(ctx.provider ?? 'github');
    const [account, repos] = await Promise.all([
      gitProvider.fetchInstallation(ctx.installationId),
      gitProvider.fetchInstallationRepos(ctx.installationId),
    ]);
    // The repos already persisted for this installation BEFORE the bind — empty on
    // a first install (all repos are new), the current set on a re-bind (only a
    // freshly-selected repo indexes). The webhook `reconcile` path only fires for
    // an ALREADY-bound installation, so a fresh install's repos would otherwise
    // never be indexed — this bind path covers them.
    const existingRepoIds = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        ctx.installationId,
        tx,
      );
      if (!installation) return [] as string[];
      const rows = await githubRepoRepository.listByInstallation(installation.id, tx);
      return rows.map((r) => r.repoId);
    });

    const dto = await this.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: ctx.installationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      },
      repos,
    });

    // POST-COMMIT, best-effort code-graph index for each newly-added repo
    // (MOTIR-1500). Never fails the bind — a dropped enqueue self-heals.
    await enqueueNewlyAddedRepos({
      installationId: ctx.installationId,
      workspaceId: ctx.workspaceId,
      repos,
      existingRepoIds,
    });
    return dto;
  },

  /**
   * Remove an installation on uninstall (the `installation` webhook with
   * `action: deleted`, MOTIR-892). System context — the webhook has no active
   * workspace. Cascades to the installation's repos + PR rows. Idempotent: a
   * redelivered uninstall (row already gone) is a no-op returning `false`.
   * Returns whether a row was actually removed.
   */
  async removeInstallation(installationId: string): Promise<boolean> {
    return withSystemContext(async (tx) => {
      const removed = await githubInstallationRepository.deleteByInstallationId(installationId, tx);
      return removed > 0;
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
