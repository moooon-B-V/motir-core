import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import type {
  ProjectRepoConnectCandidateDto,
  ProjectRepoEstablishViewDto,
} from '@/lib/dto/projectRepos';

// The READ MODEL of the establish step (Story MOTIR-1775 · MOTIR-1782) — the one
// call the "where should your code live?" step at plan approval renders from.
//
// It exists because the step needs three facts that live in three services, and a
// route handler is not allowed to compose them (CLAUDE.md's one-service-call
// rule): the project's repository SET (MOTIR-1780), the actor's GitHub IDENTITY
// (grant 1), and the workspace's INSTALLATION with the repositories it grants
// (grant 2). Composing them here also makes them ONE snapshot, which matters:
// rendering a picker built from an installation read taken after the set read
// could offer a repository a row had already claimed in between.
//
// ⚠️ THE DEFAULT PATH ASKS FOR NOTHING FROM GITHUB, and this shape is built to
// keep that true. The GitHub halves are nullable FACTS, never a "grant state":
// there is no `needsConsent`, no `grantUpgradeRequired`, no org-owner warning,
// because nothing in this flow asks the user for a GitHub permission (ADR §3
// amendment, MOTIR-1893). A missing identity or installation is simply what the
// "I already have code" door hands off to the shipped 7.10 pane for.
//
// SCOPE. Read model + nothing else. Creating repositories is the primitive
// (`projectRepoProvisioningService`, MOTIR-1781); owning the rows and the ADR §4.1
// machine is `projectRepoSetService` (MOTIR-1780); deriving the set is MOTIR-1881.
// Every mutation the step performs routes straight to those, so this service has
// exactly one method and no writes.

export const projectRepoEstablishService = {
  /**
   * Everything the establish step renders, in one browse-gated read.
   *
   * The set read is the access gate: a missing project — or one in another
   * workspace, or one the actor may not browse — throws `ProjectNotFoundError`
   * from `projectRepoSetService.getSet` before either GitHub read runs, so the
   * no-existence-leak posture is inherited rather than re-implemented.
   *
   * The GitHub reads run only AFTER that gate, and are workspace/user-scoped in
   * their own right. They are sequenced after — not `Promise.all`'d with — the set
   * read on purpose: a caller who may not see the project must not cause a read of
   * this workspace's installation at all.
   */
  async getEstablishView(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ProjectRepoEstablishViewDto> {
    const set = await projectRepoSetService.getSet(projectId, ctx);

    const [identity, installation] = await Promise.all([
      githubIdentityService.getIdentityForUser(ctx.userId),
      githubInstallationService.getWorkspaceInstallation({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      }),
    ]);

    // A repository backs at most ONE row (the `github_repo_id` unique index), so
    // the picker marks the already-claimed ones rather than offering a choice that
    // can only 409. Claimed BY THIS PROJECT is what the set read can answer; a
    // claim by another project in the workspace surfaces as the typed 409 at
    // connect time, which is the right place for it — the alternative is a read
    // that enumerates other projects' sets to grey out an option, which leaks more
    // than it helps.
    const claimed = new Set(
      set.rows.map((row) => row.realizedRepo?.id).filter((id): id is string => Boolean(id)),
    );

    const connectCandidates: ProjectRepoConnectCandidateDto[] = (installation?.repos ?? []).map(
      (repo) => ({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        repoRef: `${repo.owner}/${repo.name}`,
        defaultBranch: repo.defaultBranch,
        claimed: claimed.has(repo.id),
      }),
    );

    return {
      set,
      // Read at request time from the SAME accessor the provisioning client and
      // the CI meter use, so "which org does Motir own?" has one reader and the
      // prefix the user sees is the org a create would actually land in.
      hostOwner: provisioningOrgLogin(),
      githubLogin: identity?.githubLogin ?? null,
      hasInstallation: installation !== null,
      connectCandidates,
    };
  },
};
