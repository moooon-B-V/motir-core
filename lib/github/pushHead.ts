import { withSystemContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';

/**
 * Record the default branch's HEAD sha for a mirrored repository row — the
 * STALENESS INPUT the code graph is compared against (MOTIR-1766).
 *
 * "Stale" means the commit in the graph is behind the repository's
 * default-branch head. motir-ai holds the indexed commit; nothing held the head,
 * so answering "are we behind?" meant a provider call per repository on every
 * page render. The push delivery already carries the head — `parsePushEvent`
 * normalizes `after` into `headSha` on BOTH providers — and both webhook
 * services already establish that a delivery is a default-branch push before
 * enqueuing the refresh. This is the two lines that stop throwing it away.
 *
 * ⚠️ SHARED BY BOTH PROVIDERS ON PURPOSE. GitLab's connected projects are rows
 * in the SAME `github_repo` table (`findByRepoIdAndProvider(id, 'gitlab')`), and
 * `gitlabWebhookService.handlePush` is a structural mirror of the GitHub one
 * down to the `defaultBranch` guard. Two copies of a best-effort write is two
 * places for the swallow to drift, and it is the swallow — not the write — that
 * is the load-bearing part.
 *
 * ⚠️ BEST-EFFORT, AND IT NEVER THROWS. The webhook's contract is a fast 2xx and
 * the refresh enqueue beside it is already swallowed for exactly that reason. A
 * failed head write must not turn a delivery into a 500 that the host then
 * retries: the cost of losing one is bounded and self-healing, because the next
 * default-branch push records it, while the cost of a 500 is a retry storm on a
 * delivery no retry can fix.
 *
 * A NULL `headSha` — a payload whose `after` is missing or empty — writes
 * nothing. Null in the column means UNKNOWN, and overwriting a known head with
 * an unknown one loses information rather than recording it.
 *
 * @returns `true` when the stored head actually changed. A redelivery of the
 * same push returns `false` and writes nothing, including the timestamp.
 */
export async function recordDefaultBranchHead(
  repoRowId: string,
  headSha: string | null,
): Promise<boolean> {
  if (!headSha) return false;
  try {
    return await withSystemContext((tx) =>
      githubRepoRepository.recordDefaultBranchHead({ id: repoRowId, headSha }, tx),
    );
  } catch (err) {
    console.error('[pushHead] default-branch head not recorded; delivery acked', {
      repoRowId,
      err,
    });
    return false;
  }
}
