import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
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
// code-graph index fan-out (`codeGraphIndexService`).
//
// A PROJECT-scoped alternative now exists (MOTIR-1780): `project_repository` is
// the project's repository SET, so `projectRepoSetService.listByProject` can answer
// "this project's repos" where this function answers "the workspace's". This
// resolver is DELIBERATELY left at workspace scope — re-pointing it would change
// which repos a planning job sees, i.e. shipped, working AI-context behaviour, and
// that adoption belongs to MOTIR-1754 (the BYOK code-index loop) alongside per-repo
// index freshness. So the association is no longer missing, only unadopted here.
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
  /**
   * HAS THIS REPOSITORY GOT A CODE GRAPH (Story MOTIR-4753 · MOTIR-4826)?
   *
   * ⚠️ A FACT ON THE WIRE, NEVER A DECISION. `motir-core` supplies it exactly as
   * it supplies the ref itself; what an unindexed repository MEANS — whether the
   * person waits, or is onboarded, or plans anyway — is the routing verdict's
   * judgement (`motir-ai` MOTIR-4828), and nothing here may branch on it.
   *
   * ⚠️ AND IT EXISTS BECAUSE THE ALTERNATIVE IS INDISTINGUISHABLE. A session
   * given only the ref sees every code-graph tool answer EMPTY for a repository
   * whose index has not run — which reads exactly like a repository with nothing
   * in it, and the two support opposite verdicts. Read from the SAME succeeded-
   * index ledger the wizard's INDEX step waits on and the onboarding substrate
   * read reports from, so the three cannot disagree.
   */
  indexed: boolean;
}

/** The `context.code` unit of a planning-job envelope (the plural contract). */
export interface JobCodeContext {
  repos: JobCodeRepo[];
}

export async function resolveCodeContext(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<JobCodeContext | undefined> {
  const { repos, indexedRefs } = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const installation = await githubInstallationRepository.findByWorkspaceId(
        ctx.workspaceId,
        tx,
      );
      if (!installation) return { repos: [], indexedRefs: [] as string[] };
      const rows = await githubRepoRepository.listByInstallation(installation.id, tx);
      // ⚠️ ONE LEDGER READ FOR THE WHOLE SET, and only when there IS a set — the
      // same shape `readOnboardingSubstrate` uses, and the same read, so the
      // envelope and the reading state can never tell a user two different
      // things about the same repository.
      const indexedRefs =
        rows.length === 0
          ? []
          : await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx);
      return { repos: rows, indexedRefs };
    },
  );
  if (repos.length === 0) return undefined;
  return {
    repos: repos.map((repo) => {
      const repoRef = `${repo.owner}/${repo.name}`;
      return {
        provider: repo.provider,
        repoRef,
        defaultBranch: repo.defaultBranch,
        indexed: indexedRefs.includes(repoRef),
      };
    }),
  };
}
