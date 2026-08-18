import { type GithubCheckRun, type Prisma } from '@/generated/prisma/client';

// GitHub check-run repository — single Prisma operations on the
// `github_check_run` table (Story 7.10 · Subtask 7.10.6 / MOTIR-894). One row per
// terminal CI check of a linked PR, keyed on the unique
// `(pull_request_id, commit_sha, check_name)` — the INGESTION idempotency key: a
// redelivery / re-run of the same check at the same head commit converges on this
// row rather than recording a second one.
//
// ⚠️ `feedbackCommentId` is NOT keyed at this grain (MOTIR-2946). Every row at one
// `(pull_request_id, commit_sha)` points at the SAME feedback comment — the one
// comment that carries the aggregate verdict for that head commit. It used to be
// one comment per check name, which put ~34 of them on a motir-core work item per
// PR. The column stays here (it is where the link is stored and what
// `onDelete: SetNull` cleans up); what changed is that the consumer reads it
// across the sha's rows instead of only its own.

export interface UpsertGithubCheckRunInput {
  pullRequestId: string;
  commitSha: string;
  checkName: string;
  conclusion: string;
  feedbackCommentId: string | null;
}

export const githubCheckRunRepository = {
  /** One check row by its `(pullRequest, commitSha, checkName)` identity, or null. */
  async findByKey(
    pullRequestId: string,
    commitSha: string,
    checkName: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun | null> {
    return tx.githubCheckRun.findUnique({
      where: {
        pullRequestId_commitSha_checkName: { pullRequestId, commitSha, checkName },
      },
    });
  },

  /** Every check row recorded for a PR at one head commit — the set the work
   *  item's aggregate `ciState` is derived from (any failure → failing; all
   *  success → passing), and, since MOTIR-2946, the set the ONE feedback comment
   *  at that sha is written from. Ordered oldest-first so the comment's roll-up
   *  and its `feedbackCommentId` lookup are deterministic. */
  async listByPrAndSha(
    pullRequestId: string,
    commitSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun[]> {
    return tx.githubCheckRun.findMany({
      where: { pullRequestId, commitSha },
      orderBy: [{ createdAt: 'asc' }, { checkName: 'asc' }],
    });
  },

  /** Create-or-refresh a check row, keyed on the unique
   *  `(pull_request_id, commit_sha, check_name)`. Refreshes `conclusion` +
   *  `feedbackCommentId` so a re-run converges on one row. */
  async upsert(
    input: UpsertGithubCheckRunInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun> {
    const { pullRequestId, commitSha, checkName, ...rest } = input;
    return tx.githubCheckRun.upsert({
      where: {
        pullRequestId_commitSha_checkName: { pullRequestId, commitSha, checkName },
      },
      create: { pullRequestId, commitSha, checkName, ...rest },
      update: rest,
    });
  },
};
