import { pullRequestSubjectVersion } from '@/lib/approvalGates/pullRequestMergeHandler';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';

// THE DELIVERY SET'S VERSION — what an approve-and-merge gate names as approved (Story
// MOTIR-4909; ADR docs/decisions/approval-gates.md §8's amendment, decision 2).
//
// ⚠️ ITS OWN MODULE, AND IT IMPORTS NO SERVICE. Three places write or compare this string:
// the handler at decision time, the raise and the head-move withdrawal. The last two run
// inside the CI promotion, which `workItemsService` imports — so a helper living beside the
// handler (which imports `workItemsService` for its status write) would close a cycle at
// module-evaluation time, the one `mergeGates.ts` records for the merge handler.

/**
 * The set's canonical VERSION: each member as `owner/name#number@headSha`, sorted,
 * comma-joined — the same set always gives the same string, whatever order its rows were
 * read in.
 *
 * Null for an empty set, and null when ANY member has no known head: a set version with a
 * hole in it would claim commits nobody can name.
 */
export function deliverySetVersion(members: readonly (string | null)[]): string | null {
  if (members.length === 0 || members.some((member) => member === null)) return null;
  return [...(members as string[])].sort().join(',');
}

/**
 * One delivery row's member version — the merge handler's own spelling, so a member of the
 * set and that pull request's merge gate can never disagree about its head. `headSha` when
 * the caller knows it (a `pull_request` delivery carries it), else the latest check run's
 * commit.
 */
export function deliveryMemberVersion(
  delivery: WorkItemDeliveryWithChecks,
  headSha?: string,
): string | null {
  return pullRequestSubjectVersion(
    {
      number: delivery.pullRequest.number,
      repo: delivery.repo,
      checkRuns: delivery.pullRequest.checkRuns,
    },
    headSha,
  );
}
