import { type GithubCiFeedbackComment, type Prisma } from '@/generated/prisma/client';

// The per-card CI feedback comment repository — single Prisma operations on
// `github_ci_feedback_comment` (MOTIR-3770), specified by
// `docs/decisions/ci-feedback-comment-per-card.md`.
//
// ONE ROW PER `(pull_request_id, commit_sha, work_item_id)`: THE feedback comment
// a change request left on that card for that head commit. The comment's KEY is
// still MOTIR-2946's — one comment per change request per head commit, carrying
// the aggregate over the commit's whole check set — and this table stores the
// coordinate that key always implied and nothing could hold: which CARD it was
// posted on.
//
// ⚠️ THIS SUPERSEDED `github_check_run.feedback_comment_id`, a scalar on
// a table whose grain is one row PER CHECK. It held one id, replicated across
// every check row at the commit, so a pull request delivering N cards commented on
// exactly one of them while writing all N `ciState`s. That column is GONE:
// MOTIR-3863 took it out of the generated client and MOTIR-3803 dropped it.
// **This table is the only
// record of a feedback comment's identity** — which is also the cost, and it is
// the same one the cascade below describes: lose a row and the comment's identity
// is gone, so the next conclusion posts a fresh one.
//
// ⚠️ THE FK CASCADES ON THE COMMENT, and that is the property this shape exists
// for. The id handed to the edit path must be LIVE: a person deleting a feedback
// comment takes the row with it, so the next terminal conclusion finds nothing and
// posts a fresh one. An id column nothing keeps live would throw inside the
// delivery's transaction instead, and a webhook the host retries for ever is worse
// than any duplicate comment.

export interface UpsertGithubCiFeedbackCommentInput {
  pullRequestId: string;
  commitSha: string;
  /** The DELIVERED card the comment sits on. */
  workItemId: string;
  /** The `Comment` row. Cascade-deleted with it, never left dangling. */
  commentId: string;
}

export const githubCiFeedbackCommentRepository = {
  /** Every card's feedback comment for one change request at one head commit —
   *  the whole set in ONE read, because the caller needs it keyed by card and a
   *  per-card query would be an N+1 on the delivery path. Ordered oldest-first so
   *  it is deterministic. */
  async listByPrAndSha(
    pullRequestId: string,
    commitSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCiFeedbackComment[]> {
    return tx.githubCiFeedbackComment.findMany({
      where: { pullRequestId, commitSha },
      orderBy: [{ createdAt: 'asc' }, { workItemId: 'asc' }],
    });
  },

  /** Create-or-refresh the row for one `(change request, head commit, card)`.
   *
   *  An UPSERT rather than a create because two paths reach it with the same key:
   *  a first terminal conclusion recording the comment it just posted, and a later
   *  one ADOPTING a comment that only the legacy scalar named (a pull request whose
   *  first verdict landed before this table existed, or during the deploy window in
   *  which an older instance wrote the mirror). Both must converge on one row. */
  async upsert(
    input: UpsertGithubCiFeedbackCommentInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCiFeedbackComment> {
    const { pullRequestId, commitSha, workItemId, commentId } = input;
    return tx.githubCiFeedbackComment.upsert({
      where: {
        pullRequestId_commitSha_workItemId: { pullRequestId, commitSha, workItemId },
      },
      create: { pullRequestId, commitSha, workItemId, commentId },
      update: { commentId },
    });
  },
};
