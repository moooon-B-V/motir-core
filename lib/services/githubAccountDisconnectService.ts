import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { InstallationNotLinkedError } from '@/lib/github/errors';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubInstallationOrgLinkRepository } from '@/lib/repositories/githubInstallationOrgLinkRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { assertOrgAdmin } from '@/lib/services/organizationAccessService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import type { AccountDisconnectPreviewDto, AccountDisconnectResultDto } from '@/lib/dto/github';
import type { UsingProjectDto } from '@/lib/dto/organizationRepos';

// DISCONNECT ONE ORGANISATION FROM A GITHUB ACCOUNT (Story MOTIR-8216 ·
// MOTIR-8222). One GitHub account's installation can be linked to several
// organisations, each owning its own repositories; this removes exactly ONE
// organisation's link and repositories and leaves the installation, and every
// other organisation, alone.
//
// ⚠️ IT IS NOT THE UNINSTALL. `githubInstallationService.removeInstallation`
// deletes the whole installation row and every organisation's data with it —
// that is GitHub telling Motir the App is gone, and it is reachable only from the
// webhook. Nothing here calls it. The App stays installed on GitHub whatever this
// does; a later Connect re-creates what it removed through the link flow.
//
// The shape is `organizationRepoService.disconnectFromOrganisation`'s, because
// it already encodes each table's RLS: enumerate the affected projects BEFORE
// the delete (MOTIR-2166), clear the project links one workspace at a time
// (`project_repository` writes are workspace-keyed with no system arm), delete
// under the system context, offboard the code graph after commit.

/** The link, the installation and this organisation's repos under it, read
 *  inside one org-bound, admin-gated transaction. */
async function loadOwnLink(ctx: ServiceContext, installationId: string) {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
    await assertOrgAdmin(ctx.userId, organizationId, tx);
    await bindOrganizationContext(tx, organizationId);
    const installation = await githubInstallationRepository.findByInstallationId(
      installationId,
      tx,
    );
    const link = installation
      ? await githubInstallationOrgLinkRepository.findByInstallationAndOrg(
          installation.id,
          organizationId,
          tx,
        )
      : null;
    // No link — never connected, already disconnected, or the shared
    // provisioning installation (which no organisation is linked to).
    if (!installation || !link) throw new InstallationNotLinkedError();
    const repos = await githubRepoRepository.listByInstallationAndOrg(
      installation.id,
      organizationId,
      tx,
    );
    const projectIdsByRepo = new Map<string, string[]>();
    for (const repo of repos) {
      const links = await projectRepoRepository.listByGithubRepoId(repo.id, tx);
      projectIdsByRepo.set(
        repo.id,
        links.map((l) => l.projectId),
      );
    }
    return { organizationId, installation, repos, projectIdsByRepo };
  });
}

export const githubAccountDisconnectService = {
  /**
   * What disconnecting the organisation from this account will do — the
   * dialog's facts. `projects` is `listRepositoryUsage`'s list (live, browse-
   * filtered) narrowed to this account's repos, so the dialog and the act read
   * one definition of "used by". Names no other organisation.
   */
  async previewAccountDisconnect(
    ctx: ServiceContext & { installationId: string },
  ): Promise<AccountDisconnectPreviewDto> {
    const { installation, repos } = await loadOwnLink(ctx, ctx.installationId);
    const ids = new Set(repos.map((repo) => repo.id));
    const usage = await organizationRepoService.listRepositoryUsage(ctx);
    const projects = new Map<string, UsingProjectDto>();
    for (const row of usage) {
      if (!ids.has(row.githubRepoId)) continue;
      for (const project of row.projects) projects.set(project.id, project);
    }
    return {
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repos: repos.map((repo) => ({
        githubRepoId: repo.id,
        repoRef: `${repo.owner}/${repo.name}`,
      })),
      projects: [...projects.values()],
      retentionWindowDays: CODE_GRAPH_RETENTION_WINDOW_DAYS,
    };
  },

  /**
   * Disconnect the actor's organisation from one GitHub account: its link row
   * and its repositories go, its projects' links are cleared (the rows stay — a
   * project's plan outlives the connection), its code graph enters the windowed
   * offboarding. Another organisation's link, repositories and projects are
   * untouched. The installation row stays while any organisation is linked; when
   * the organisation leaving is the one its legacy tenancy names, that tenancy
   * moves to the oldest remaining link, and when none remains the row goes.
   */
  async disconnectAccountFromOrganization(
    ctx: ServiceContext & { installationId: string },
  ): Promise<AccountDisconnectResultDto> {
    const { organizationId, installation, repos, projectIdsByRepo } = await loadOwnLink(
      ctx,
      ctx.installationId,
    );

    // ENUMERATE BEFORE THE DELETE (MOTIR-2166), archived projects INCLUDED: an
    // archived project's derived graph still exists, and the offboarding is
    // what removes it.
    const allProjectIds = [...new Set([...projectIdsByRepo.values()].flat())];
    const workspaceByProject = await withSystemContext(async (tx) => {
      const projects = await projectRepository.findManyByIds(allProjectIds, tx);
      return new Map(projects.map((project) => [project.id, project.workspaceId]));
    });
    // workspace → (projects, repo refs) it must offboard, and the repos whose
    // links it holds.
    const affected = new Map<
      string,
      { projectIds: Set<string>; repoRefs: Set<string>; repoIds: Set<string> }
    >();
    for (const repo of repos) {
      for (const projectId of projectIdsByRepo.get(repo.id) ?? []) {
        const workspaceId = workspaceByProject.get(projectId);
        if (!workspaceId) continue;
        const entry = affected.get(workspaceId) ?? {
          projectIds: new Set<string>(),
          repoRefs: new Set<string>(),
          repoIds: new Set<string>(),
        };
        entry.projectIds.add(projectId);
        entry.repoRefs.add(`${repo.owner}/${repo.name}`);
        entry.repoIds.add(repo.id);
        affected.set(workspaceId, entry);
      }
    }

    // ONE BOUND WRITE PER AFFECTED WORKSPACE — the only context that can clear a
    // `project_repository` link is that link's own workspace. The authorisation
    // happened once, at the org-admin gate.
    let clearedLinks = 0;
    for (const [workspaceId, entry] of affected) {
      clearedLinks += await withWorkspaceContext(
        { userId: ctx.userId, workspaceId },
        async (tx) => {
          let cleared = 0;
          for (const repoId of entry.repoIds) {
            cleared += await projectRepoRepository.clearGithubRepoLinks(repoId, workspaceId, tx);
          }
          return cleared;
        },
      );
    }

    const installationRemoved = await withSystemContext(async (tx) => {
      // Serialises with a concurrent claim by another organisation.
      await githubInstallationRepository.lockByInstallationId(installation.installationId, tx);
      await githubRepoRepository.deleteByInstallationAndOrg(installation.id, organizationId, tx);
      await githubInstallationOrgLinkRepository.deleteByInstallationAndOrg(
        installation.id,
        organizationId,
        tx,
      );
      const remaining = await githubInstallationOrgLinkRepository.listByInstallationId(
        installation.id,
        tx,
      );
      if (remaining.length === 0) {
        await githubInstallationRepository.deleteByInstallationId(installation.installationId, tx);
        return true;
      }
      const current = await githubInstallationRepository.findByInstallationId(
        installation.installationId,
        tx,
      );
      if (current && current.organizationId === organizationId) {
        const next = remaining[0]!;
        await githubInstallationRepository.restampTenancy(
          installation.id,
          next.workspaceId,
          next.organizationId,
          tx,
        );
      }
      return false;
    });

    // POST-COMMIT, BEST-EFFORT: the disconnect has committed, so a failed queue
    // write must not report a false failure. Windowed — reconnecting inside the
    // window cancels it.
    for (const [workspaceId, entry] of affected) {
      await codeGraphOffboardingService.enqueueQuietly({
        coreWorkspaceId: workspaceId,
        coreProjectIds: [...entry.projectIds],
        repoRefs: [...entry.repoRefs],
        reason: 'repo_disconnected',
      });
    }

    return {
      releasedRepos: repos.map((repo) => `${repo.owner}/${repo.name}`),
      clearedLinks,
      installationRemoved,
    };
  },
};
