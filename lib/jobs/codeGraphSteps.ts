import type { JobContext } from './defineJob';
import type { JobServices } from './services';
import type {
  IndexRepoInput,
  IndexRepoResult,
  IndexTarget,
} from '@/lib/services/codeGraphIndexService';

// The STEP SHAPE shared by the two code-graph jobs — `system.code-graph-index`
// (first index on repo add) and `system.code-graph-refresh` (a default-branch
// push). They differ only in what triggers them; the work they drive is the same
// service, so the durable-execution shape lives here once rather than being
// copied into both definitions and drifting.
//
// ⚠️ THE SHAPE IS THE FIX (MOTIR-1974). Inngest checkpoints BETWEEN steps and
// re-invokes the handler at each boundary, so a STEP — not a run — is the unit
// the platform's function timeout applies to. Both jobs used to run their whole
// body (one tarball fetch, then one motir-ai upload per project, sequentially)
// inside a single `step.run`, so one invocation had to cover all of it. It never
// fit: in production all five repos exhausted their 5 attempts on
// `FUNCTION_INVOCATION_TIMEOUT` and dead-lettered — the tiny starter repo
// exactly like `motir-core`, which is what proves the failure was wall-clock and
// not size. Now:
//
//   step 1        `resolve-target`       — DB reads, no network
//   step 2..N+1   `index-project:<id>`   — ONE project's fetch + upload
//
// so each invocation covers exactly one fetch + one upload (replayed steps come
// back from Inngest's memo without executing), a partial failure RESUMES at the
// project it died on instead of restarting the repo, and the budget it runs
// against is the serve route's explicit `maxDuration` (`app/api/inngest/route.ts`)
// rather than a silent platform default.
export async function runCodeGraphIndexSteps(
  ctx: JobContext,
  services: JobServices,
  input: IndexRepoInput,
): Promise<IndexRepoResult> {
  const target = (await ctx.step.run('resolve-target', () =>
    services.codeGraph.resolveIndexTarget(input),
  )) as IndexTarget;
  // A vanished tenant / project-less workspace is a clean no-op, and its reason
  // is what the ledger records as the run's output.
  if (!target.indexed) return target;

  // Keyed by projectId, not by loop position: the step id is what Inngest
  // memoizes against, so it must identify the SAME unit of work on every replay.
  // A project id still does that if the workspace's project list changes between
  // attempts, where a positional index would silently re-point at another
  // project.
  for (const projectId of target.projectIds) {
    await ctx.step.run(`index-project:${projectId}`, () =>
      services.codeGraph.indexRepoIntoProject({
        ...input,
        providerId: target.providerId,
        organizationId: target.organizationId,
        repoRef: target.repoRef,
        projectId,
      }),
    );
  }

  return {
    indexed: true,
    repoRef: target.repoRef,
    projectsIndexed: target.projectIds.length,
  };
}
