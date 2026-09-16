import type { GithubMergeQueueAttempt, Prisma } from '@/generated/prisma/client';

// Merge-queue ATTEMPT repository — single Prisma operations on
// `github_merge_queue_attempt` (Story MOTIR-5461 · MOTIR-5633;
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 8).
//
// One row per pull request per merge group the queue tested. A pull request's
// "attempt" always means its LATEST row.

export interface MergeQueueAttemptCreateInput {
  pullRequestId: string;
  repoId: string;
  headSha: string;
  headRef: string;
}

export interface FailingCheck {
  name: string;
  url: string;
  at: Date;
}

export const githubMergeQueueAttemptRepository = {
  /** Record attempts; one that already exists for its `(pullRequestId, headSha)` is
   *  skipped, so a redelivered `checks_requested` writes nothing. Returns how many were
   *  new. Write path → `tx`. */
  async createManyIfAbsent(
    rows: readonly MergeQueueAttemptCreateInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.githubMergeQueueAttempt.createMany({
      data: [...rows],
      skipDuplicates: true,
    });
    return result.count;
  },

  /** Every attempt the queue tested at one commit of one repository. */
  async findByRepoAndSha(
    repoId: string,
    headSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubMergeQueueAttempt[]> {
    return tx.githubMergeQueueAttempt.findMany({ where: { repoId, headSha } });
  },

  /** Name the attempt's failing check — only if none is named yet, which is what makes
   *  the FIRST failure to complete win and a redelivery a no-op. Returns the count.
   *  Write path → `tx`. */
  async setFailingCheckIfUnset(
    attemptId: string,
    check: FailingCheck,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubMergeQueueAttempt.updateMany({
      where: { id: attemptId, failingCheckName: null },
      data: { failingCheckName: check.name, failingCheckUrl: check.url, failedAt: check.at },
    });
    return result.count;
  },

  /** The pull request's LATEST attempt, if the queue ever tested it. */
  async findLatestByPullRequest(
    pullRequestId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubMergeQueueAttempt | null> {
    return tx.githubMergeQueueAttempt.findFirst({
      where: { pullRequestId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
