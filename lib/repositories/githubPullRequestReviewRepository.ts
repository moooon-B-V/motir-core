import type {
  GithubPullRequestReview,
  GithubRepositoryPermission,
  GithubReviewState,
  Prisma,
} from '@/generated/prisma/client';

// GITHUB REVIEW repository — single Prisma operations on
// `github_pull_request_review` (Story MOTIR-4910 · MOTIR-5594;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decisions 2, 4 and 7).
//
// One row per GitHub review, keyed on GitHub's own `review.id`. This leaf stores and
// returns rows; it decides NOTHING about whether a review counts — that tuple
// (state, commit, dismissal, permission) is read at evaluation time by the evaluator
// (MOTIR-5597), and the Development block (MOTIR-5602) deliberately reads rows that
// do NOT count so it can draw them.

export interface GithubPullRequestReviewUpsertInput {
  /** GitHub's `review.id` — the idempotency key. */
  githubReviewId: string;
  githubPullRequestId: string;
  reviewerGithubUserId: string;
  reviewerLogin: string;
  /** `review.user.type` — `User` or `Bot`, as GitHub gives it. */
  reviewerType: string;
  state: GithubReviewState;
  /** `review.commit_id` — the head the review was given AT. */
  commitSha: string;
  reviewerPermission: GithubRepositoryPermission;
  submittedAt: Date;
  htmlUrl?: string | null;
}

export const githubPullRequestReviewRepository = {
  /**
   * Record one review, or update the one this `githubReviewId` already names.
   *
   * ⚠️ A ROW IN `dismissed` NEVER LEAVES IT. GitHub delivers `submitted` and
   * `dismissed` as separate events and does not promise their order, so an
   * out-of-order redelivery of the original `submitted` would otherwise resurrect a
   * review the reviewer has withdrawn — and a resurrected approval decides a gate.
   * The guard is in the `where`, not in a read-then-write: `state: { not: 'dismissed' }`
   * makes the update a no-op row-wise when the row is dismissed, so two concurrent
   * writers cannot straddle it.
   *
   * Write path → `tx` required.
   */
  async upsertByGithubReviewId(
    input: GithubPullRequestReviewUpsertInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestReview> {
    const {
      githubReviewId,
      githubPullRequestId,
      reviewerGithubUserId,
      reviewerLogin,
      reviewerType,
      state,
      commitSha,
      reviewerPermission,
      submittedAt,
      htmlUrl = null,
    } = input;

    // The dismissal guard is a conditional updateMany rather than an upsert's
    // `update` block, because an upsert cannot express "update only if". A row that
    // is dismissed matches nothing here and is left exactly as it stands.
    const updated = await tx.githubPullRequestReview.updateMany({
      where: { githubReviewId, state: { not: 'dismissed' } },
      data: { state, reviewerPermission, submittedAt, reviewerLogin, htmlUrl },
    });

    if (updated.count === 0) {
      // Either the row is dismissed (leave it), or it does not exist (create it).
      const existing = await tx.githubPullRequestReview.findUnique({ where: { githubReviewId } });
      if (existing) return existing;

      try {
        return await tx.githubPullRequestReview.create({
          data: {
            githubReviewId,
            githubPullRequestId,
            reviewerGithubUserId,
            reviewerLogin,
            reviewerType,
            state,
            commitSha,
            reviewerPermission,
            submittedAt,
            htmlUrl,
          },
        });
      } catch (err) {
        // A genuinely concurrent first write lost the unique race. The winner's row
        // is the answer — neither caller throws, and exactly one row exists. P2002 is
        // matched by code rather than by instanceof, so this does not import the
        // Prisma namespace into a signature (the type-boundary rule).
        if ((err as { code?: string }).code !== 'P2002') throw err;
        const winner = await tx.githubPullRequestReview.findUnique({ where: { githubReviewId } });
        if (!winner) throw err;
        return winner;
      }
    }

    const row = await tx.githubPullRequestReview.findUnique({ where: { githubReviewId } });
    if (!row) throw new Error(`github review ${githubReviewId} vanished after update`);
    return row;
  },

  /**
   * Every review for these pull requests, in ONE query.
   *
   * It filters to no head and drops no state on purpose: the evaluator narrows to the
   * gate's `subjectVersion` heads itself, and the Development block needs the reviews
   * at OTHER heads in order to draw *Approved an earlier commit* (design § 23, Panel
   * G2). A read that pre-filtered here would make that panel unbuildable.
   *
   * Read path — takes `tx` because both callers read inside the transaction that then
   * decides or renders against the result.
   */
  async listForPullRequests(
    githubPullRequestIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestReview[]> {
    if (githubPullRequestIds.length === 0) return [];
    return tx.githubPullRequestReview.findMany({
      where: { githubPullRequestId: { in: githubPullRequestIds } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    });
  },
};
