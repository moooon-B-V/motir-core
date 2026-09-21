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
  /** The merge-queue check that failed, when the pull request's latest attempt names
   *  one (MOTIR-5633). */
  failingCheckName?: string | null;
  failingCheckUrl?: string | null;
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

  /** CLAIM an exit for *Queue again* (MOTIR-5634): stamp `requeuedAt` only if nobody
   *  has. Returns the count — 0 means another press claimed it first. The
   *  `requeued_at IS NULL` predicate is what makes two presses enqueue once. Write
   *  path → `tx`. */
  async claimRequeue(exitId: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.githubPullRequestQueueExit.updateMany({
      where: { id: exitId, requeuedAt: null },
      data: { requeuedAt: at },
    });
    return result.count;
  },

  /** RELEASE a claim this press made, when the host refused the re-enqueue — only the
   *  stamp it wrote, so a later press's claim is never undone. Write path → `tx`. */
  async releaseRequeue(exitId: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.githubPullRequestQueueExit.updateMany({
      where: { id: exitId, requeuedAt: at },
      data: { requeuedAt: null },
    });
    return result.count;
  },

  /** Name a FAILURE exit's failing check — only if none is named yet (MOTIR-5633).
   *  For a check that completed after the exit was written. Returns the count. Write
   *  path → `tx`. */
  async setFailingCheckIfUnset(
    exitId: string,
    check: { name: string; url: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequestQueueExit.updateMany({
      where: { id: exitId, disposition: 'failure', failingCheckName: null },
      data: { failingCheckName: check.name, failingCheckUrl: check.url },
    });
    return result.count;
  },

  /** Every pull request holding a FAILURE exit nobody has re-queued — the candidate
   *  set of the ejected-card convergence (MOTIR-5809). Distinct ids; whether that exit
   *  is still the pull request's LATEST is the caller's to check. Cross-tenant: read
   *  under the system context. */
  async listPullRequestIdsWithStandingFailure(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.githubPullRequestQueueExit.findMany({
      where: { disposition: 'failure', requeuedAt: null },
      select: { pullRequestId: true },
      distinct: ['pullRequestId'],
    });
    return rows.map((row) => row.pullRequestId);
  },

  /** The same scan, over EVERY disposition (MOTIR-5809): a NEUTRAL removal spends an
   *  approval exactly as a failure does, so the convergence has to see it. */
  async listPullRequestIdsWithStandingExit(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.githubPullRequestQueueExit.findMany({
      where: { requeuedAt: null },
      select: { pullRequestId: true },
      distinct: ['pullRequestId'],
    });
    return rows.map((row) => row.pullRequestId);
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
