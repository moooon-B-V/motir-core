import type {
  GithubPullRequestQueueExit,
  Prisma,
  QueueExitDisposition,
} from '@/generated/prisma/client';

// Merge-queue EXIT repository — single Prisma operations on
// `github_pull_request_queue_exit` (Story MOTIR-5461 · MOTIR-5632;
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decisions 3 and 9).
//
// One row per removal that did not merge. Rows accumulate, so "the pull request's
// exit" always means its LATEST row.

export interface QueueExitCreateInput {
  pullRequestId: string;
  /** The `X-GitHub-Delivery` GUID — UNIQUE. */
  deliveryId: string;
  rawReason: string;
  disposition: QueueExitDisposition;
  headSha: string;
  exitedAt: Date;
}

export const githubPullRequestQueueExitRepository = {
  /** The row one delivery wrote, if any — the redelivery check, read under the pull
   *  request's row lock so two copies of one delivery cannot both miss it. */
  async findByDeliveryId(
    deliveryId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestQueueExit | null> {
    return tx.githubPullRequestQueueExit.findUnique({ where: { deliveryId } });
  },

  /** Record one exit. Write path → `tx`. A duplicate `deliveryId` raises P2002; the
   *  service reads first under a lock, so that is a concurrency backstop, not the
   *  idempotency mechanism. */
  async create(
    input: QueueExitCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestQueueExit> {
    return tx.githubPullRequestQueueExit.create({ data: input });
  },

  /** Each pull request's LATEST exit, keyed by pull request id — ONE query for a
   *  whole delivery set. A pull request never ejected is simply absent. Ties on
   *  `exitedAt` fall to the newest row. */
  async findLatestByPullRequests(
    pullRequestIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, GithubPullRequestQueueExit>> {
    if (pullRequestIds.length === 0) return new Map();
    const rows = await tx.githubPullRequestQueueExit.findMany({
      where: { pullRequestId: { in: [...pullRequestIds] } },
      orderBy: [{ exitedAt: 'asc' }, { createdAt: 'asc' }],
    });
    const latest = new Map<string, GithubPullRequestQueueExit>();
    for (const row of rows) latest.set(row.pullRequestId, row);
    return latest;
  },
};
