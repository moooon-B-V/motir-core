import type { GithubPullRequestMergeRefusal, Prisma } from '@/generated/prisma/client';

// MERGE REFUSAL repository — single Prisma operations on
// `github_pull_request_merge_refusal` (Story MOTIR-5799 · MOTIR-5833;
// `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 5).
//
// One row per merge the HOST refused at the press. Rows accumulate — a person may
// change the setting and press again — so "the pull request's refusal" always means
// its LATEST row, exactly as it does for a merge-queue exit.

export interface MergeRefusalCreateInput {
  pullRequestId: string;
  /** The host's own code, verbatim (`lib/git/types.ts`'s `MergeRefusalCode`). */
  code: string;
  /** The head the press was made against. */
  headSha: string;
  /** The gate whose approval the press spent; null for a design-carried press. */
  approvalGateId?: string | null;
  /** `app_permission_missing` only. */
  permission?: string | null;
  refusedAt: Date;
}

export const githubPullRequestMergeRefusalRepository = {
  /** Record one refusal. Write path → `tx`. */
  async create(
    data: MergeRefusalCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestMergeRefusal> {
    return tx.githubPullRequestMergeRefusal.create({
      data: {
        pullRequestId: data.pullRequestId,
        code: data.code,
        headSha: data.headSha,
        approvalGateId: data.approvalGateId ?? null,
        permission: data.permission ?? null,
        refusedAt: data.refusedAt,
      },
    });
  },

  /** The LATEST refusal of each pull request named, or no entry where there is none. */
  async findLatestByPullRequests(
    pullRequestIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, GithubPullRequestMergeRefusal>> {
    if (pullRequestIds.length === 0) return new Map();
    const rows = await tx.githubPullRequestMergeRefusal.findMany({
      where: { pullRequestId: { in: [...pullRequestIds] } },
      orderBy: [{ refusedAt: 'asc' }, { createdAt: 'asc' }],
    });
    const latest = new Map<string, GithubPullRequestMergeRefusal>();
    for (const row of rows) latest.set(row.pullRequestId, row);
    return latest;
  },

  /** Retire every refusal a pull request still carries — a later press at that head
   *  succeeded, or the pull request merged. Idempotent: a row already stamped is
   *  left alone, so the first stamp is the one that stands. */
  async supersedeStanding(
    pullRequestId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequestMergeRefusal.updateMany({
      where: { pullRequestId, supersededAt: null },
      data: { supersededAt: at },
    });
    return result.count;
  },
};
