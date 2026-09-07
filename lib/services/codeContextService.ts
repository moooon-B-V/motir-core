import { withWorkspaceContext } from '@/lib/workspaces/context';
import { deriveCodeGraphIndexState } from '@/lib/codeGraph/indexState';
import { resolveDriftCount } from '@/lib/codeGraph/driftCount';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type { CodeContextDTO, CodeContextRepoDTO } from '@/lib/dto/codeContext';

// The CODE-CONTEXT service (Story MOTIR-1754 · MOTIR-1767) — the single read both
// of this story's planning surfaces are fed from. It answers one question:
// **what code can the planner see FOR THIS PROJECT, and how current is it?**
//
// ⚠️ IT COMPUTES NOTHING. `lib/codeGraph/indexState.ts` (MOTIR-4724) is THE ONE
// derivation of the four index states, and `tests/codeGraph/indexState.test.ts`
// asserts no second implementation of "stale" exists under `lib/`. That module's
// own header names *the `Code` page (MOTIR-1754)* as a surface that must not be
// able to disagree with it — so this service ASSEMBLES FACTS and hands them over.
//
// This file's first revision did the opposite: it carried a `resolveVerdict` of
// its own, comparing an indexed sha against a head sha, and a `CodeRepoVerdict`
// union to name the answers. Both are gone. A second comparison written here
// would not be caught by a type — it would just be a different answer on a
// different screen, which is the failure the guard exists to prevent.
//
// The ORG-scoped twin is `organizationRepoService.listRepositoryUsage`, which
// answers *"what does this ORGANISATION have?"*. This one answers *"what does
// THIS PROJECT work on?"* — a different question over the same facts, and the
// reason both exist. Read it for the shape; do not duplicate its body.

/** The three reads this service needs, assembled in one workspace-bound transaction. */
async function readFacts(
  projectId: string,
  ctx: AccessActorContext,
): Promise<{
  rows: Awaited<ReturnType<typeof projectRepoRepository.listByProject>>;
  indexedRefs: Set<string>;
  runningRunIds: Set<string>;
  hasImplementedWork: boolean;
}> {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    // THE PROJECT'S SET — never the workspace installation's grant list. A
    // project sees the repositories somebody configured it with; a repository
    // absent here is absent because nobody added it, which is a scoping fact and
    // not a privacy boundary (the repository belongs to the organisation).
    const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);

    // "Has anybody reported implementing work here?" — EXISTS-shaped, not a row
    // scan.
    const implemented = await tx.workItem.findFirst({
      where: { projectId, implementationSource: { not: null } },
      select: { id: true },
    });

    // WHICH refs have ever been indexed successfully. The ledger is the only
    // place that knows: a succeeded `system.code-graph-index` run writes its
    // `output.repoRef`.
    const indexedRefs = new Set(
      await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx),
    );

    // ⚠️ WHICH claimed runs are ACTUALLY still running — resolved against the
    // LEDGER, never against the column alone. `GithubRepo.indexingRunId` is a
    // POINTER, not a state: a crashed run leaves it set for ever, and a row that
    // read `indexing` for ever after would be worse than one that never read it.
    // One read for the whole set rather than one per row, which is also what
    // makes a crashed run self-healing — an `abandoned` row is simply not in this
    // set.
    const running = await tx.jobRun.findMany({
      where: { functionId: 'system.code-graph-index', status: 'running' },
      select: { id: true },
    });

    return {
      rows,
      indexedRefs,
      runningRunIds: new Set(running.map((r) => r.id)),
      hasImplementedWork: implemented !== null,
    };
  });
}

/**
 * The PROJECT's code context, WITHOUT the access gate.
 *
 * ⚠️ UNGATED ON PURPOSE, and exported for exactly one kind of caller: a
 * PLANNING-JOB SUBMIT, which has already authorized the actor before it assembles
 * an envelope and must not re-run a browse check it would pass by construction.
 * Every BROWSER-facing read goes through {@link codeContextService.getCodeContext},
 * which gates first. One join with two doors is what stops the planning surface
 * and the planner disagreeing about the same repository.
 */
export async function resolveCodeContextState(
  projectId: string,
  ctx: AccessActorContext,
): Promise<CodeContextDTO> {
  const { rows, indexedRefs, runningRunIds, hasImplementedWork } = await readFacts(projectId, ctx);

  const repos: CodeContextRepoDTO[] = rows.flatMap((row) => {
    // A row whose `githubRepoId` is null is PROPOSED, not realized — a plan for a
    // repository that does not exist yet. There is no graph to have a state
    // about, so it contributes nothing rather than a fabricated `never`.
    const repo = row.githubRepo;
    if (!repo) return [];
    const repoRef = `${repo.owner}/${repo.name}`;
    return [
      {
        repoRef,
        provider: repo.provider,
        indexState: deriveCodeGraphIndexState({
          hasSucceededIndex: indexedRefs.has(repoRef),
          defaultBranchHeadSha: repo.defaultBranchHeadSha,
          indexedHeadSha: repo.indexedHeadSha,
          hasRunningIndex: repo.indexingRunId !== null && runningRunIds.has(repo.indexingRunId),
        }),
        indexedAt: repo.indexedAt,
        // ⚠️ THE STORED COUNT, SERVED ONLY IF IT BELONGS TO THE PAIR ON THE ROW
        // RIGHT NOW (MOTIR-4644). `resolveDriftCount` is the one rule; a
        // comparison written here would be a second definition of "still
        // current". `null` remains a first-class answer — never computed, a pair
        // that has since moved, no common ancestor, or a host that could not
        // answer all render the same way.
        //
        // ⚠️ AND THIS READ MAKES NO PROVIDER CALL. MOTIR-1766 kept the head off
        // the render path on purpose; the count is computed by the recompute job
        // and read from a column, exactly like the head it is compared against.
        commitsBehind: resolveDriftCount(repo),
      },
    ];
  });

  return { hasCodeContext: repos.length > 0, repos, hasImplementedWork };
}

export const codeContextService = {
  /**
   * The active project's code context, for a BROWSER.
   *
   * ⚠️ Gated on BROWSE, not on `ai:configure`. `aiConventionService` gates its
   * reads on `ai:configure` because a convention is AI CONFIGURATION; this is
   * not — it is the honest state of the planner's inputs, rendered beside the
   * thing that is about to use them. Anyone who can open that surface needs it.
   */
  async getCodeContext(projectId: string, ctx: AccessActorContext): Promise<CodeContextDTO> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    return resolveCodeContextState(projectId, ctx);
  },
};
