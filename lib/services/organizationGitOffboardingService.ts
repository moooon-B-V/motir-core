import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { appInstallationsClient } from '@/lib/github/appInstallations';
import { repoDeletionClient } from '@/lib/github/repoDeletion';
import { revokeToken } from '@/lib/gitlab/gitlabOAuth';
import { removeProjectWebhook } from '@/lib/gitlab/projectWebhook';
import { decryptToken } from '@/lib/gitlab/tokenCrypto';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ORGANIZATION GIT OFFBOARDING (Story MOTIR-6306 · MOTIR-6397;
// `docs/decisions/organization-deletion.md` §6 — Git is the erasure's FIRST step).
// Given an organization being erased, remove every trace of it from the Git hosts
// Motir controls, and touch nothing the customer owns:
//
//   1. every repository row of the org, one at a time —
//        a Motir-HOSTED GitHub repository is DELETED on GitHub, then its row;
//        a customer-OWNED repository keeps its GitHub life: only our row goes;
//   2. every GitHub App installation the org owns —
//        UNINSTALLED, then its row, when it serves this org alone;
//        only UNLINKED when another organization still has repositories behind
//        it: this org's rows went in 1, and the installation passes to that org;
//   3. every GitLab connection the org owns — Motir's project webhooks taken off
//      and the stored tokens revoked (both best-effort), then the row, whose
//      repository rows cascade.
//
// ⚠️ `isMotirHostedOwner` IS THE ONLY DISCRIMINATOR, and it is asserted PER
// REPOSITORY immediately before the delete call (bug MOTIR-4892 is why nothing
// else is trusted: `github_repo.organization_id` answers "can this tenant dispatch
// into it", never "whose is it"). A deployment with no provisioning org hosts
// nothing, so on it this deletes no repository at all.
//
// ⚠️ THE PERMISSION: deleting a hosted repository runs under the provisioning App's
// Repository "Administration: write", which MOTIR-1779 granted for repository
// creation — verified in `docs/decisions/ci-minutes-allowance.md` (the permissions
// list: *"POST /orgs/{org}/repos … Repository permissions for Administration,
// write — the grant MOTIR-1779 already provisions"*) and relied on by
// `lib/github/repoTransfer.ts` for the transfer. GitHub documents `DELETE
// /repos/{owner}/{repo}` under the same heading. See `lib/github/repoDeletion.ts`.
//
// ⚠️ EVERY REMOTE CALL IS ITS OWN STEP WITH ITS OWN ROW WRITE, so it resumes. A
// repository's row is deleted in its own transaction only after its remote delete
// succeeded; a failure THROWS and stops the run with every earlier repository
// already gone and every later one still present, and the next run picks up
// there. The remote calls are idempotent (a 404 is success), so a crash between a
// remote delete and its row write re-issues a delete that answers "already gone".
// A second run over a finished org finds no rows, makes no remote call and
// returns zeros.
//
// SYSTEM context throughout: the organization is being erased and nobody acts.
// `github_repo`, `github_installation` and `github_pull_request` all carry a
// `*_workspace_or_system` ALL policy, which admits the reads and the deletes.

export interface GitOffboardingCounts {
  /** Motir-hosted repositories deleted on GitHub (or found already gone). */
  hostedReposDeleted: number;
  /** Customer-owned repository rows removed — never touched on the host. */
  customerRepoRowsRemoved: number;
  /** GitHub App installations uninstalled and their rows deleted. */
  installationsUninstalled: number;
  /** Installations shared with another organization: this org's rows removed and
   *  the installation handed to the org still using it — never uninstalled. */
  installationsUnlinked: number;
  /** GitLab connections whose rows were removed (tokens revoked best-effort). */
  gitlabConnectionsRemoved: number;
}

/** The host seams — injectable so the tests stub the network, not the database. */
export interface GitOffboardingDeps {
  deleteRepo: typeof repoDeletionClient.deleteRepo;
  uninstallInstallation: typeof appInstallationsClient.uninstallInstallation;
  removeGitlabWebhook: typeof removeProjectWebhook;
  revokeGitlabToken: typeof revokeToken;
  hostOwner: () => string | null;
}

const LIVE_DEPS: GitOffboardingDeps = {
  deleteRepo: (input) => repoDeletionClient.deleteRepo(input),
  uninstallInstallation: (id) => appInstallationsClient.uninstallInstallation(id),
  removeGitlabWebhook: removeProjectWebhook,
  revokeGitlabToken: revokeToken,
  hostOwner: provisioningOrgLogin,
};

function zero(): GitOffboardingCounts {
  return {
    hostedReposDeleted: 0,
    customerRepoRowsRemoved: 0,
    installationsUninstalled: 0,
    installationsUnlinked: 0,
    gitlabConnectionsRemoved: 0,
  };
}

/** Decrypt a stored GitLab token, or null when there is none or it cannot be read. */
function readToken(encrypted: string | null): string | null {
  if (!encrypted) return null;
  try {
    return decryptToken(encrypted);
  } catch {
    return null;
  }
}

export const organizationGitOffboardingService = {
  /**
   * Remove organization `organizationId` from every Git host Motir controls. Safe
   * to re-run at any point; returns what THIS run did. Throws on the first remote
   * failure of a repository delete or an uninstall, leaving the rest for the next
   * run.
   */
  async offboardGit(
    organizationId: string,
    deps: GitOffboardingDeps = LIVE_DEPS,
  ): Promise<GitOffboardingCounts> {
    const counts = zero();
    const hostOwner = deps.hostOwner();

    // ── 1 · Repository rows, one at a time ───────────────────────────────────
    const repos = await withSystemContext((tx) =>
      githubRepoRepository.listByOrganizationWithInstallation(organizationId, tx),
    );
    for (const repo of repos) {
      // A GitLab project hanging off one of this org's own connections goes with
      // that connection in step 3 (its webhook is taken off first).
      if (repo.provider === 'gitlab' && repo.installation.organizationId === organizationId) {
        continue;
      }
      const onGithub = repo.provider === 'github';
      if (onGithub && isMotirHostedOwner(repo.owner, hostOwner)) {
        await deps.deleteRepo({
          installationId: repo.installation.installationId,
          owner: repo.owner,
          repo: repo.name,
        });
        counts.hostedReposDeleted += 1;
      } else {
        counts.customerRepoRowsRemoved += 1;
      }
      await withSystemContext((tx) => githubRepoRepository.deleteById(repo.id, tx));
    }

    // ── 2 + 3 · The org's own connections ────────────────────────────────────
    const installations = await withSystemContext((tx) =>
      githubInstallationRepository.listAllProvidersByOrganizationId(organizationId, tx),
    );
    for (const installation of installations) {
      if (installation.provider === 'gitlab') {
        const projectIds = await withSystemContext(async (tx) =>
          (await githubRepoRepository.listByInstallation(installation.id, tx)).map((r) => r.repoId),
        );
        const accessToken = readToken(installation.accessTokenEncrypted);
        if (accessToken) {
          for (const projectId of projectIds) {
            try {
              await deps.removeGitlabWebhook(accessToken, projectId);
            } catch (err) {
              console.error(`[git-offboarding] GitLab webhook removal failed (${projectId})`, err);
            }
          }
          await deps.revokeGitlabToken(accessToken);
        }
        const refreshToken = readToken(installation.refreshTokenEncrypted);
        if (refreshToken) await deps.revokeGitlabToken(refreshToken);
        await withSystemContext((tx) =>
          githubInstallationRepository.deleteByInstallationId(installation.installationId, tx),
        );
        counts.gitlabConnectionsRemoved += 1;
        continue;
      }

      const sharedWith = await withSystemContext((tx) =>
        githubRepoRepository.findOtherOrganizationId(installation.id, organizationId, tx),
      );
      if (sharedWith !== null) {
        // Another live organization still reaches repositories through it. This
        // org's repository rows went in step 1; the installation passes to the
        // org still using it, so a re-run no longer finds it here.
        await withSystemContext((tx) =>
          githubInstallationRepository.setOrganizationId(installation.id, sharedWith, tx),
        );
        counts.installationsUnlinked += 1;
        continue;
      }
      await deps.uninstallInstallation(installation.installationId);
      await withSystemContext((tx) =>
        githubInstallationRepository.deleteByInstallationId(installation.installationId, tx),
      );
      counts.installationsUninstalled += 1;
    }

    return counts;
  },
};
