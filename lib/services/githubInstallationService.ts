import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { toGithubInstallationDTO } from '@/lib/mappers/githubMappers';
import { getGitProvider } from '@/lib/git';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import type { GithubRepo } from '@/generated/prisma/client';
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
    const { dto, prunedRefs, selectedRefs } = await withSystemContext(async (tx) => {
      // THE OWNING ORGANISATION (Story MOTIR-4669 · MOTIR-4649), resolved THROUGH
      // the workspace. `workspace.organizationId` is NOT NULL, so this read is
      // total for any workspace that exists — a missing workspace is a caller
      // error and throws rather than writing a null tenancy.
      const organizationId = await resolveOrganizationId(input.workspaceId, tx);
      const installation = await githubInstallationRepository.upsert(
        {
          installationId: input.installation.installationId,
          workspaceId: input.workspaceId,
          organizationId,
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
        },
        tx,
      );

      // WHICH repos this reconcile is about to DROP (MOTIR-2166 ·
      // `docs/decisions/code-graph-index-fleet.md` §14.3). Read BEFORE
      // `deleteExcept` runs, because a pruned row's `owner/name` — the `repoRef`
      // the offboarding queue is keyed by — is gone the moment it is deleted.
      // Same ordering trap as the workspace-delete arm, one scale down.
      const selectedIds = new Set(input.repos.map((repo) => repo.providerRepoId));
      const beforePrune = await githubRepoRepository.listByInstallation(installation.id, tx);
      const prunedRefs = beforePrune
        .filter((repo) => !selectedIds.has(repo.repoId))
        .map((repo) => `${repo.owner}/${repo.name}`);

      for (const repo of input.repos) {
        await githubRepoRepository.upsert(
          {
            installationId: installation.id,
            // The repo's OWN tenancy (MOTIR-1931) — the same workspace this
            // installation is bound to, since this path only ever runs for a
            // workspace's own grant.
            workspaceId: input.workspaceId,
            // …and the tier that OWNS it (MOTIR-4649). Stamped on every write, so
            // a row written between the migration and the backfill is not left
            // null either — which is what makes the nullable column safe.
            organizationId,
            repoId: repo.providerRepoId,
            owner: repo.owner,
            name: repo.name,
            defaultBranch: repo.defaultBranch,
            // The host's own liveness, re-stamped on every reconcile (MOTIR-1959)
            // — this delivery is the cheapest refresh Motir gets, and a repo the
            // user archived between two reconciles has to stop reading as live.
            archived: repo.archived,
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
      return {
        dto: toGithubInstallationDTO(installation, repos),
        prunedRefs,
        selectedRefs: repos.map((repo) => `${repo.owner}/${repo.name}`),
      };
    });

    // POST-COMMIT, BEST-EFFORT — the repo-disconnect arm of §14.3, reached from
    // the GitHub side. A repo dropped from the installation's SELECTION is a
    // disconnect: its `github_repo` row is gone, so nothing here will ever index
    // it again, and its derived graph must go with it after the window.
    await codeGraphOffboardingService.enqueueForRepos(
      input.workspaceId,
      prunedRefs,
      'repo_disconnected',
    );

    // …and the mirror: a repo that IS in the selection has a pending removal
    // called off. A reconcile is exactly how a user re-selects a repo they
    // de-selected earlier, which is the re-onboard §14.3 says must cancel the
    // window. Unconditional over the whole selection, because it is idempotent
    // and a no-op when nothing is pending — cheaper than tracking which of these
    // rows is new.
    await codeGraphOffboardingService.cancelForRepos(input.workspaceId, selectedRefs);

    return dto;
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
          // NULL for the SAME reason, and this is the one row the column is
          // nullable FOR (MOTIR-4649). An installation shared across tenants can
          // name no organisation any more than it can name a workspace; the
          // repository rows below carry the tenancy, as they already did.
          organizationId: null,
          accountLogin: input.installation.accountLogin,
          accountType: input.installation.accountType,
        },
        tx,
      );
      // The REPOSITORY, by contrast, always has one — resolved through the
      // workspace it was created for.
      const organizationId = await resolveOrganizationId(input.workspaceId, tx);
      return githubRepoRepository.upsert(
        {
          installationId: installation.id,
          workspaceId: input.workspaceId,
          organizationId,
          repoId: input.repo.providerRepoId,
          owner: input.repo.owner,
          name: input.repo.name,
          defaultBranch: input.repo.defaultBranch,
          // A repository Motir just created is never archived, so this is
          // `false` in practice — recorded from the host's own value anyway
          // rather than assumed, so there is one rule for how the column is
          // filled and no path that hardcodes an answer (MOTIR-1959).
          archived: input.repo.archived,
        },
        tx,
      );
    });
  },

  /**
   * Apply a repository's ARCHIVED / UNARCHIVED state from the host (MOTIR-1959) —
   * the `repository` delivery's write, and the reason the recorded liveness stays
   * true instead of freezing at whatever it was when the row was mirrored.
   *
   * System context, like every other installation write: the webhook has no active
   * workspace. Idempotent by construction — the repository's `updateMany` makes a
   * redelivery a no-op, and re-applying the same value writes the same row.
   *
   * Returns whether any mirror row was touched. `false` is the ordinary answer for
   * a repository Motir does not mirror at all: the shared provisioning
   * installation sees deliveries for repositories belonging to no project row, and
   * that is not an error to raise.
   */
  async applyArchivedState(input: { providerRepoId: string; archived: boolean }): Promise<boolean> {
    return withSystemContext(async (tx) => {
      const count = await githubRepoRepository.setArchivedByRepoId(
        input.providerRepoId,
        input.archived,
        tx,
      );
      return count > 0;
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
    const dto = await this.persistInstallation({
      workspaceId: ctx.workspaceId,
      installation: {
        installationId: ctx.installationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      },
      repos,
    });

    // POST-COMMIT, best-effort code-graph index for each repo that has no graph
    // yet (MOTIR-1500; re-gated on indexedness by MOTIR-1961, so a repo persisted
    // before the feature existed is finally reachable). Never fails the bind.
    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: ctx.installationId,
      workspaceId: ctx.workspaceId,
      repos,
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
