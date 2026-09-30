// THE HOST'S MERGEABILITY, READ ONE WAY (MOTIR-5913, for bug MOTIR-5907).
//
// `GithubPullRequest.mergeableState` is GitHub's answer to *can this merge into its
// base right now?*, stored with the head it was read at. Three readers act on it — the
// merge-candidate predicate (`mergeCandidateHead`), CI promotion (`isPromotable`) and
// `motir fix`'s repair predicate — and they must agree, so the rule lives here once.
//
// ⚠️ A CONFLICT IS `dirty` AT THE MEMBER'S CURRENT HEAD, AND NOTHING ELSE. `null` is
// "not asked / not computed yet" and is never a conflict (the MOTIR-5699 rule for
// `draft`); a reading taken at another head says nothing about the current one.
//
// ⚠️ AND THE CURRENT HEAD IS THE PULL REQUEST'S, NOT THE CHECK ROWS' (MOTIR-7005). This
// used to compare the reading against the newest check run's commit, on the assumption
// that a reading could only be OLDER than that (a `synchronize` clears it). A push that
// produced no CI — every push to a conflicting pull request — made the reading NEWER,
// and the rule inverted: the conflict at the real head was discarded as stale. The head
// is `lib/github/pullRequestHead.ts`'s.

import { pullRequestHead, type PullRequestHeadSlice } from './pullRequestHead';

/** The stored reading, as the readers see it. */
export interface StoredMergeability {
  mergeableState: string | null;
  mergeableStateHeadSha: string | null;
}

/** The host's word for "conflicts with its base". */
export const CONFLICTED_MERGEABLE_STATE = 'dirty';

/**
 * Whether the stored reading says this pull request conflicts AT `headSha`.
 * `headSha` null means the caller does not know the current head; then the reading's
 * own head stands, because a `synchronize` clears the reading when the head moves.
 */
export function isConflictedAt(pr: StoredMergeability, headSha: string | null): boolean {
  if (pr.mergeableState !== CONFLICTED_MERGEABLE_STATE) return false;
  if (pr.mergeableStateHeadSha === null) return false;
  return headSha === null || headSha === pr.mergeableStateHeadSha;
}

/** {@link isConflictedAt} at the pull request's head ({@link pullRequestHead}). */
export function isConflictedAtCurrentHead(pr: StoredMergeability & PullRequestHeadSlice): boolean {
  return isConflictedAt(pr, pullRequestHead(pr));
}
