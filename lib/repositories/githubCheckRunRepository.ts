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
// ⚠️ THE FEEDBACK COMMENT'S IDENTITY IS NOT HERE ANY MORE, AND NEITHER IS ITS
// COLUMN (MOTIR-3770 → MOTIR-3863 → MOTIR-3803). It was `feedback_comment_id`, a scalar on a
// table whose grain is one row PER CHECK: never keyed at this grain (MOTIR-2946
// made every row at one `(pull_request_id, commit_sha)` point at the same
// comment), and unable to name more than one card however many a pull request
// delivers. `github_ci_feedback_comment` supersedes it, keyed on
// `(pull request, head commit, work item)` — read THAT.
//
// The COLUMN IS GONE. It was retired over the three phases
// `docs/decisions/delivery-reader-migration.md` §6a specifies: MOTIR-3863
// `@ignore`d the field so the generated client stopped selecting it — including
// through the bare relation includes nobody can grep for — MOTIR-3864 verified
// that build had reached every machine, and MOTIR-3803 then dropped the column
// and its FK. Doing the last two in one release is MOTIR-3852, an outage.

export interface UpsertGithubCheckRunInput {
  pullRequestId: string;
  commitSha: string;
  checkName: string;
  /** The CI run — `''` where the provider reports none. Never null: Postgres
   *  treats NULLs in a unique index as distinct, so a nullable member would
   *  stop the upsert converging (see the schema's note). */
  checkSuiteId: string;
  conclusion: string;
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
   *  subset (`liveCheckRows`), and the caller needs the whole set to derive it.
   *  Ordered oldest-first so the answer is deterministic. */
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
   *  `conclusion` so a REDELIVERY of one run's check converges on one row —
   *  while a DIFFERENT run's check of the same name gets its own row, which is
   *  what lets the derivation retire the loser. */
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
