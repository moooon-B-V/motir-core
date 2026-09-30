import { vi } from 'vitest';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { adminDb } from './adminDb';

/**
 * The host answers CLEAN at `headSha` for pull request `number` in this workspace, and
 * the `pull-request/head-moved` re-read settles it (MOTIR-7063).
 *
 * A `synchronize` marks the reading pending at the new head, and a green build does not
 * promote — or re-ask about — a head whose reading is still owed. A test that pushes and
 * then expects the next green to ask a person must first let the host say the new head
 * still merges, exactly as production does. The host is the one thing stubbed.
 */
export async function hostAnswersCleanAt(
  workspaceId: string,
  number: number,
  headSha: string,
  /** The repository's name, where the workspace has several with this number. */
  repoName?: string,
): Promise<void> {
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({
    where: { number, repo: { workspaceId, ...(repoName ? { name: repoName } : {}) } },
  });
  const github = getGitProvider('github') as Required<GitProvider>;
  const spy = vi
    .spyOn(github, 'readChangeRequestMergeability')
    .mockResolvedValue({ mergeable: true, mergeableState: 'clean', headSha });
  try {
    await pullRequestMergeabilityService.settleHeadMember(workspaceId, {
      pullRequestId: pr.id,
      number,
    });
  } finally {
    spy.mockRestore();
  }
}
