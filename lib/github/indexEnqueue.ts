import { inngest } from '@/lib/jobs/client';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import type { NormalizedRepo } from '@/lib/git/types';

// Best-effort, POST-COMMIT enqueue of the `system.code-graph-index` job for a
// NEWLY-ADDED GitHub repo (Story 7.5 · MOTIR-1500). The single chokepoint both
// repo-add paths call — the webhook reconcile (`installation` /
// `installation_repositories`) and the fresh-install bind — so the fetch + the
// motir-ai handoff always run in the background job, never inline in the request.
//
// MUST be called AFTER the installation's repos persist: the grant mirror is the
// source of truth and the index is a SIDE EFFECT that must never fail or roll
// back the grant (PROD-443 — coupling a committed mutation to a transport call
// turns it into a 500 on a blip). So a failed enqueue is swallowed + logged. The
// job is idempotent, so a dropped enqueue self-heals on the next repo-selection
// change (or a manual replay).

/** Enqueue ONE repo's index job. Swallows + logs a transport failure. */
export async function enqueueCodeGraphIndex(data: CodeGraphIndexData): Promise<void> {
  try {
    await inngest.send({ name: 'system.code-graph-index', data });
  } catch (err) {
    console.error(
      `enqueueCodeGraphIndex(${data.installationId} ${data.repoOwner}/${data.repoName}) failed ` +
        `to enqueue; the repos persisted but the code-graph index was dropped:`,
      err,
    );
  }
}

/**
 * Enqueue an index job for each repo in `repos` whose provider repo id is NOT in
 * `existingRepoIds` — i.e. exactly the newly-added repos of a reconcile / bind.
 * A re-selection that adds nothing enqueues nothing. Best-effort per repo (one
 * failure never blocks the others or the caller).
 */
export async function enqueueNewlyAddedRepos(input: {
  installationId: string;
  workspaceId: string;
  repos: NormalizedRepo[];
  existingRepoIds: Iterable<string>;
}): Promise<void> {
  const existing = new Set(input.existingRepoIds);
  for (const repo of input.repos) {
    if (existing.has(repo.providerRepoId)) continue;
    await enqueueCodeGraphIndex({
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      repoOwner: repo.owner,
      repoName: repo.name,
      defaultBranch: repo.defaultBranch,
    });
  }
}
