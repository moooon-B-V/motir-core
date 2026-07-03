import { withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { indexCodeGraph } from '@/lib/ai/motirAiClient';

// codeGraphIndexService (Story 7.5 · MOTIR-1500, the motir-core producer half) —
// the business logic behind the `system.code-graph-index` background job. When a
// GitHub App installation adds a repo, motir-core fetches that repo's source at
// its default branch using the INSTALLATION token, then hands the raw
// gzipped-tarball BYTES to motir-ai to build a code graph. The credential + fetch
// stay in motir-core; motir-ai receives bytes, never a host token (the open-core
// invariant, docs/ai-boundary.md).
//
// 4-layer (CLAUDE.md): the job handler is the "service caller" for a background
// trigger, so ALL the orchestration lives here, not in the definition file — the
// handler just wraps this in a memoized `step.run`, exactly as `billingSeatSync`
// delegates to `billingService`. This service owns the repository reads (through
// the leaves), the RLS context, and the boundary calls.
//
// TENANCY (the RESOLVED current-stage fan-out): a GitHub installation binds to a
// WORKSPACE (`GithubInstallation.workspaceId`, no project), but motir-ai's
// code-graph tenant is PROJECT-scoped (the planner resolves `aiProjectId` from a
// planning job's `projectId`). So this slice resolves the installation's
// workspace → its `organizationId` → ALL its projects, and calls motir-ai ONCE
// PER PROJECT with the SAME tarball bytes. A repo installed at a workspace is
// therefore indexed into each of that workspace's projects' code-graph stores.
// A precise repo↔project association (to avoid indexing a repo into unrelated
// projects) is a future refinement — deliberately NOT built here.
//
// SIDE-EFFECTS-OUTSIDE-TX: the DB reads run inside one `withSystemContext`
// transaction (RLS-safe under the trusted-writer escape, like the webhook); the
// tarball fetch and the per-project motir-ai calls are network side effects done
// AFTER that transaction closes — a transaction is never held open across a
// GitHub / motir-ai round-trip.

export interface IndexRepoInput {
  /** GitHub's numeric installation id (as a string) — the token-minting key. */
  installationId: string;
  repoOwner: string;
  repoName: string;
  /** The ref to index — the repo's default branch. */
  defaultBranch: string;
}

/** A small JSON-serializable summary persisted on the job_run ledger row. */
export type IndexRepoResult =
  | { indexed: false; reason: 'installation_missing' | 'workspace_missing' | 'no_projects' }
  | { indexed: true; repoRef: string; projectsIndexed: number };

export const codeGraphIndexService = {
  /**
   * Fetch one repo's tarball once and index it into every project of the
   * installation's workspace. No-ops cleanly (never throws) when the
   * installation/workspace vanished before the job ran or the workspace has no
   * projects. Any GitHub / motir-ai failure propagates so the job's idempotent
   * retry budget can absorb a transient blip.
   */
  async indexRepoIntoWorkspaceProjects(input: IndexRepoInput): Promise<IndexRepoResult> {
    // Phase 1 — resolve the tenant tuple under system context (DB reads only).
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        input.installationId,
        tx,
      );
      if (!installation) return { kind: 'installation_missing' as const };

      const workspace = await workspaceRepository.findByIdInTx(installation.workspaceId, tx);
      if (!workspace) return { kind: 'workspace_missing' as const };

      const projects = await projectRepository.findByWorkspace(installation.workspaceId, tx);
      return {
        kind: 'resolved' as const,
        providerId: installation.provider as GitProviderId,
        workspaceId: installation.workspaceId,
        organizationId: workspace.organizationId,
        projectIds: projects.map((p) => p.id),
      };
    });

    if (resolved.kind === 'installation_missing')
      return { indexed: false, reason: 'installation_missing' };
    if (resolved.kind === 'workspace_missing')
      return { indexed: false, reason: 'workspace_missing' };
    if (resolved.projectIds.length === 0) return { indexed: false, reason: 'no_projects' };

    // Phase 2 — network side effects OUTSIDE the transaction. Fetch the tarball
    // ONCE (via the provider seam, dispatched by the stored discriminator), then
    // hand the same bytes to motir-ai per project.
    const provider = getGitProvider(resolved.providerId);
    const repoRef = `${input.repoOwner}/${input.repoName}`;
    const bytes = await provider.fetchRepoTarball(
      input.installationId,
      input.repoOwner,
      input.repoName,
      input.defaultBranch,
    );

    for (const projectId of resolved.projectIds) {
      await indexCodeGraph({
        coreOrganizationId: resolved.organizationId,
        coreWorkspaceId: resolved.workspaceId,
        coreProjectId: projectId,
        repoRef,
        bytes,
      });
    }

    return { indexed: true, repoRef, projectsIndexed: resolved.projectIds.length };
  },
};
