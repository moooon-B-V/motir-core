import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// Resolve the CODE half of a planning-job context bag (Subtask 7.10.15 ·
// MOTIR-1598) — the workspace's connected repo SET, read from the persisted
// installation grant mirror (7.10.3 · MOTIR-891). This is the PRODUCER side of
// the `context.code.repos[]` cross-repo contract with motir-ai's multi-repo
// code-graph reads (7.10.16 · MOTIR-1599).
//
// Shared by every PLANNING-job dispatch entry point (`generate_tree` today; the
// augment / expand_item / replan submits adopt it when they land) so the
// resolution lives in one place — the exact shape `resolveTenantOrg` set for the
// org half. Scoping is the WORKSPACE's connected set (a workspace is one
// product, so its projects share the product's repos), matching the 7.5
// code-graph index fan-out (`codeGraphIndexService`) — which resolves that
// service's deferred "precise repo↔project association" note by design.
//
// A DB read ONLY (the 891 mirror rows) — never a GitHub API round-trip on the
// submit path. No installation, or an installation with no granted repos,
// resolves to `undefined` so the caller OMITS `context.code` entirely and a
// start-fresh project's envelope stays byte-identical to a code-less one.

/** One connected repo as it rides the job envelope. */
export interface JobCodeRepo {
  /** The git-provider discriminator (`"github"` today; the GitProvider seam). */
  provider: string;
  /** `owner/name` — the ref motir-ai keys its per-repo code-graph stores on. */
  repoRef: string;
  defaultBranch: string;
}

/** The `context.code` unit of a planning-job envelope (the plural contract). */
export interface JobCodeContext {
  repos: JobCodeRepo[];
}

export async function resolveCodeContext(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<JobCodeContext | undefined> {
  const repos = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const installation = await githubInstallationRepository.findByWorkspaceId(
        ctx.workspaceId,
        tx,
      );
      if (!installation) return [];
      return githubRepoRepository.listByInstallation(installation.id, tx);
    },
  );
  if (repos.length === 0) return undefined;
  return {
    repos: repos.map((repo) => ({
      provider: repo.provider,
      repoRef: `${repo.owner}/${repo.name}`,
      defaultBranch: repo.defaultBranch,
    })),
  };
}
