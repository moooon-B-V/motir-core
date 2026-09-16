import type { Prisma } from '@/generated/prisma/client';
import type { NormalizedMergeGroupAttempt, NormalizedUnlinkedCheckFailure } from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubMergeQueueAttemptRepository } from '@/lib/repositories/githubMergeQueueAttemptRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// WHICH CHECK MADE THE MERGE QUEUE GIVE UP (Story MOTIR-5461 · MOTIR-5633).
//
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 8. A merge-queue
// check is reported against the merge GROUP's commit, with `pull_requests: []` and
// no head branch (MOTIR-5627), so nothing on the check names a pull request. The
// `merge_group` `checks_requested` delivery does, and it arrives before any of the
// group's checks can complete. So:
//
//   1. `recordAttempt` — at `checks_requested`, one ATTEMPT row per pull request the
//      group's `head_ref` names, keyed by the group's `head_sha`;
//   2. `attachFailingCheck` — a failed check at a known attempt's sha names that
//      attempt's failing check. The FIRST failure to complete wins, which also makes
//      a redelivered check a no-op;
//   3. the failure EXIT copies the check from the pull request's latest attempt
//      (`mergeQueueExitService.recordExit`). A check that completes AFTER the exit
//      was written is attached to that exit here too, so neither order loses it.
//
// ⚠️ NEVER `github_check_run`. That table is the pull request's OWN CI state at its
// head (`derivePrCiState`); a group's red check written there would turn a green
// pull request red and stop a push from re-arming the card's approval. Nothing here
// writes a card status or a CI state.
//
// Every read and write runs in ONE system transaction that binds the tenant as soon
// as the repository row names it, the pattern of `mergeQueueExitService`'s first
// phase. No actor is needed: nothing attributable changes.

export type MergeGroupOutcome =
  /** Attempts were written (or already existed). */
  | 'recorded'
  /** None of the pull requests the group names is mirrored. */
  | 'unknown_pull_request'
  | 'unknown_installation'
  | 'unknown_repo'
  /** Any `merge_group` action other than `checks_requested`. */
  | 'ignored_action'
  | 'malformed';

export interface MergeGroupResult {
  event: 'merge_group';
  outcome: MergeGroupOutcome;
  /** Attempts newly written by this delivery. */
  recorded?: number;
}

export interface FailingCheckAttachResult {
  /** Attempts this check was named on. */
  attempts: number;
  /** Failure exits this check was named on — the check completed after the exit. */
  exits: number;
}

async function resolveRepo(
  installationId: string | null,
  providerRepoId: string,
  tx: Prisma.TransactionClient,
): Promise<{ id: string } | 'unknown_installation' | 'unknown_repo'> {
  if (!installationId) return 'unknown_installation';
  const installation = await githubInstallationRepository.findByInstallationId(installationId, tx);
  if (!installation) return 'unknown_installation';
  const repo = await githubRepoRepository.findByInstallationAndRepoId(
    installation.id,
    providerRepoId,
    tx,
  );
  if (!repo) return 'unknown_repo';
  await bindWorkspaceContext(tx, repo.workspaceId);
  return { id: repo.id };
}

export const mergeQueueCheckService = {
  /** Record the attempt a `checks_requested` delivery starts, for every pull request
   *  its ref names that Motir mirrors. Idempotent on redelivery. */
  async recordAttempt(input: {
    installationId: string | null;
    attempt: NormalizedMergeGroupAttempt;
  }): Promise<MergeGroupResult> {
    const { attempt } = input;
    return withSystemContext(async (tx): Promise<MergeGroupResult> => {
      const repo = await resolveRepo(input.installationId, attempt.providerRepoId, tx);
      if (typeof repo === 'string') return { event: 'merge_group', outcome: repo };
      const rows = [];
      for (const number of attempt.prNumbers) {
        const pr = await githubPullRequestRepository.findByRepoAndNumber(repo.id, number, tx);
        if (!pr) continue;
        rows.push({
          pullRequestId: pr.id,
          repoId: repo.id,
          headSha: attempt.headSha,
          headRef: attempt.headRef,
        });
      }
      if (rows.length === 0) return { event: 'merge_group', outcome: 'unknown_pull_request' };
      const recorded = await githubMergeQueueAttemptRepository.createManyIfAbsent(rows, tx);
      return { event: 'merge_group', outcome: 'recorded', recorded };
    });
  },

  /**
   * Name a FAILED check on every attempt the queue ran at its commit, and on each such
   * pull request's latest failure exit when that exit came after the attempt and names
   * no check yet. A check at a commit no attempt names — an ordinary branch, or a
   * group whose `checks_requested` was never delivered — attaches nothing.
   */
  async attachFailingCheck(input: {
    installationId: string | null;
    check: NormalizedUnlinkedCheckFailure;
  }): Promise<FailingCheckAttachResult> {
    const { check } = input;
    return withSystemContext(async (tx): Promise<FailingCheckAttachResult> => {
      const none = { attempts: 0, exits: 0 };
      const repo = await resolveRepo(input.installationId, check.providerRepoId, tx);
      if (typeof repo === 'string') return none;
      const attempts = await githubMergeQueueAttemptRepository.findByRepoAndSha(
        repo.id,
        check.headSha,
        tx,
      );
      if (attempts.length === 0) return none;
      const named = { name: check.name, url: check.url, at: check.completedAt };
      const result = { ...none };
      for (const attempt of attempts) {
        result.attempts += await githubMergeQueueAttemptRepository.setFailingCheckIfUnset(
          attempt.id,
          named,
          tx,
        );
        // The exit only takes a check from the pull request's LATEST attempt, and only
        // an exit written after that attempt began is about it.
        const latestAttempt = await githubMergeQueueAttemptRepository.findLatestByPullRequest(
          attempt.pullRequestId,
          tx,
        );
        if (latestAttempt?.id !== attempt.id) continue;
        const exit = (
          await githubPullRequestQueueExitRepository.findLatestByPullRequests(
            [attempt.pullRequestId],
            tx,
          )
        ).get(attempt.pullRequestId);
        if (!exit || exit.exitedAt < attempt.createdAt) continue;
        // Re-read the attempt: an earlier failure may already have named it, and the
        // exit carries the same check the attempt does.
        const current = await githubMergeQueueAttemptRepository.findLatestByPullRequest(
          attempt.pullRequestId,
          tx,
        );
        result.exits += await githubPullRequestQueueExitRepository.setFailingCheckIfUnset(
          exit.id,
          { name: current!.failingCheckName!, url: current!.failingCheckUrl! },
          tx,
        );
      }
      return result;
    });
  },
};
