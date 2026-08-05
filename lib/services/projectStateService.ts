import type { MigrateIndexRepoDto, MigrateIndexStatusDto } from '@/lib/dto/migrateOnboarding';
import type { ProjectStateDto } from '@/lib/dto/projectState';
import { toMigrateOnboardingDto } from '@/lib/mappers/migrateOnboardingMappers';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The project's PLANNING PRECONDITIONS, in ONE read (MOTIR-1968) — an ADAPTER
// over four shipped reads, not a new capability.
//
// WHY it exists: an agent planning over the MCP could not check a single thing
// about the tenant it was planning FOR. MOTIR-1755 was authored twice on
// unverified tenant state — "the repos were never connected" (they had been, for
// months) and then "the code graph is driven by the grant" (zero of five repos
// had a graph, and no shipped path could ever give them one) — and neither claim
// was checkable over the surface. The second cost a whole card of manual audit
// and produced MOTIR-1961 + MOTIR-1963. This service is the read that turns both
// assertions into questions.
//
// SCOPE: read-only, and everything it reads is a `motir-core` table. There is no
// write here — no way to stamp the marker, trigger an index, or advance a
// migrate run — and no `motir-ai` round-trip, which is what keeps this one repo.
// Pre-plan document contents and the code-graph query surface stay behind the
// open-core boundary; the planner already reaches those through the job envelope.
//
// COMPOSITION, deliberately: every answer is the SHIPPED one.
//   * established?      → `resolvePlanningHostGate` (the function the planning
//                          doors read), never a re-derivation of the marker
//   * code connected?   → `githubInstallationRepository.findByWorkspaceId` →
//                          `githubRepoRepository.listByInstallation`, the pair
//                          `resolveCodeContext` uses
//   * code indexed?     → the succeeded-index ledger, projected into the wizard's
//                          `MigrateIndexStatusDto`
//   * project's repos?  → `projectRepoSetService.listByProject` (MOTIR-1780)
//   * onboarding state? → the project's `MigrateOnboarding` run, or null
//
// COST: constant in the number of repos. The index state comes from ONE ledger
// query (`listSucceededCodeGraphIndexRepoRefs` → a Set) rather than the per-repo
// `findSucceededCodeGraphIndex` the wizard's poll issues — an N+1 the wizard can
// afford at its single-digit repo count and an MCP read should not inherit.

/** The workspace-scoped half: the installation, its repos, and their index state. */
async function resolveCodeState(
  ctx: ServiceContext,
): Promise<{ installed: boolean; index: MigrateIndexStatusDto }> {
  // ONE workspace-scoped transaction for all four reads, so the job_run + github
  // RLS policies see the bound workspace GUC and the whole answer is consistent.
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    const installation = await githubInstallationRepository.findByWorkspaceId(ctx.workspaceId, tx);
    const repos = installation
      ? await githubRepoRepository.listByInstallation(installation.id, tx)
      : [];

    // The whole ledger for this workspace in one query — the N+1 the per-repo
    // lookup would be. `output.repoRef` is `owner/name`, the same spelling
    // `resolveCodeContext` builds, so the Set membership test is exact.
    const indexedRefs = new Set(
      await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx),
    );
    const running = await jobRunRepository.findRunningCodeGraphIndexForWorkspace(
      ctx.workspaceId,
      tx,
    );

    const rows: MigrateIndexRepoDto[] = repos.map((repo) => {
      const repoRef = `${repo.owner}/${repo.name}`;
      return {
        provider: repo.provider,
        repoRef,
        // `pending` covers "queued", "in flight" AND "nothing ever tried" — the
        // ledger cannot separate them per repo (a running row carries no
        // repoRef), and MOTIR-1961's repos sat in the third of those forever.
        status: indexedRefs.has(repoRef) ? 'indexed' : 'pending',
      };
    });
    const indexedCount = rows.filter((row) => row.status === 'indexed').length;
    const total = rows.length;

    return {
      installed: installation !== null,
      index: {
        repos: rows,
        indexedCount,
        total,
        hasRunning: running !== null,
        // `total > 0` deliberately: "every one of zero repos is indexed" is a
        // true statement and a useless one. Matches the wizard's Next gate.
        allIndexed: total > 0 && indexedCount === total,
      },
    };
  });
}

export const projectStateService = {
  /**
   * A project's planning preconditions — established?, code connected + indexed?,
   * repository set, where onboarding stopped — resolved by project KEY.
   *
   * TENANCY is structural, not checked here: `projectsService.getByKey` resolves
   * the key INSIDE the token-bound workspace and browse-gates the result, so a
   * key belonging to another tenant reads as `ProjectNotFoundError` — the same
   * 404-not-403 answer an unknown key gets, with no existence leak. `projectKey`
   * is therefore not a way around the binding: it selects within it.
   *
   * Every downstream read is scoped by the SAME `ctx`, so no branch of this
   * answer can come from a workspace the caller is not in.
   */
  async getProjectState(projectKey: string, ctx: ServiceContext): Promise<ProjectStateDto> {
    const project = await projectsService.getByKey(projectKey, ctx);

    // The verdict is the shipped gate's, not a marker re-read. `hasActiveProject`
    // and `canBrowse` are true BY CONSTRUCTION at this point — the key resolved
    // to a project and `getByKey` asserted browse — so the gate reduces here to
    // the onboarding question, which is the one this read exists to answer.
    const planningGate = resolvePlanningHostGate({
      hasActiveProject: true,
      canBrowse: true,
      onboardingRanAt: project.onboardingRanAt,
    });

    const code = await resolveCodeState(ctx);
    const repoSet = await projectRepoSetService.listByProject(project.id, ctx);
    const run = await migrateOnboardingRepository.findByProjectId(project.id, ctx.workspaceId);

    return {
      project: {
        key: project.identifier,
        id: project.id,
        name: project.name,
        onboardingRanAt: project.onboardingRanAt,
      },
      planningGate,
      code,
      repoSet,
      onboarding: run ? toMigrateOnboardingDto(run) : null,
    };
  },
};
