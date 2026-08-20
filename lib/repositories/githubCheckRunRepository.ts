import { type GithubCheckRun, type Prisma } from '@/generated/prisma/client';

// GitHub check-run repository — single Prisma operations on the
// `github_check_run` table (Story 7.10 · Subtask 7.10.6 / MOTIR-894). One row per
// terminal CI check of a linked PR, keyed on the unique
// `(pull_request_id, commit_sha, check_name, check_suite_id)` — the INGESTION
// idempotency key: a redelivery of the same check of the same RUN at the same
// head commit converges on this row rather than recording a second one.
//
// ⚠️ THE SUITE IS IN THE KEY, AND THAT IS THE POINT (MOTIR-3209). It used to be
// `(pull_request_id, commit_sha, check_name)`, which reads a check's NAME as its
// identity. `cancel-in-progress` (MOTIR-3106) makes two workflow runs at one
// commit ordinary, the two runs do not use the same names — a matrix job
// cancelled before expansion reports the literal `${{ matrix.* }}` template —
// and so the cancelled run's rows outlived the run that replaced them wherever
// the names differ. Merging them was never idempotency; it was two runs written
// into one. Which rows still get a VOTE is `lib/github/checkSuites.ts`.
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
  /** The CI run — `''` where the provider reports none. Never null: Postgres
   *  treats NULLs in a unique index as distinct, so a nullable member would
   *  stop the upsert converging (see the schema's note). */
  checkSuiteId: string;
  conclusion: string;
  feedbackCommentId: string | null;
}

export const githubCheckRunRepository = {
  /** One check row by its `(pullRequest, commitSha, checkName, checkSuiteId)`
   *  identity, or null. */
  async findByKey(
    pullRequestId: string,
    commitSha: string,
    checkName: string,
    checkSuiteId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun | null> {
    return tx.githubCheckRun.findUnique({
      where: {
        pullRequestId_commitSha_checkName_checkSuiteId: {
          pullRequestId,
          commitSha,
          checkName,
          checkSuiteId,
        },
      },
    });
  },

  /** Every check row recorded for a PR at one head commit — EVERY run's,
   *  including a superseded one's. The verdict is derived from the surviving
   *  subset (`liveCheckRows`), but the `feedbackCommentId` lookup deliberately
   *  reads the whole set: the comment is keyed per `(change request, head sha)`
   *  (MOTIR-2946), so a replacement run must find and EDIT the comment the run
   *  it replaced opened, never start a second one. Ordered oldest-first so both
   *  are deterministic. */
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
   *  `(pull_request_id, commit_sha, check_name, check_suite_id)`. Refreshes
   *  `conclusion` + `feedbackCommentId` so a REDELIVERY of one run's check
   *  converges on one row — while a DIFFERENT run's check of the same name gets
   *  its own row, which is what lets the derivation retire the loser. */
  async upsert(
    input: UpsertGithubCheckRunInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun> {
    const { pullRequestId, commitSha, checkName, checkSuiteId, ...rest } = input;
    return tx.githubCheckRun.upsert({
      where: {
        pullRequestId_commitSha_checkName_checkSuiteId: {
          pullRequestId,
          commitSha,
          checkName,
          checkSuiteId,
        },
      },
      create: { pullRequestId, commitSha, checkName, checkSuiteId, ...rest },
      update: rest,
    });
  },
};
