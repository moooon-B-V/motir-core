import { liveRowsAtLatestSha } from '@/lib/github/prCiState';
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
 * ONE MEMBER's version — `owner/name#number@headSha` — for `headSha` when a caller knows
 * it (a `pull_request` delivery carries it), else the latest check run's commit. Null when
 * neither names a head.
 *
 * ⚠️ IT MOVED HERE FROM THE MERGE HANDLER (MOTIR-5616). It was written for the
 * per-pull-request `pull_request_merge` gate, whose subject was one pull request; that kind
 * is retired and its handler deleted, but the spelling survives it — the approve-and-merge
 * gate names each MEMBER of its delivery set in exactly this form, and the merge entry
 * point compares against it. This module is its right home for the reason stated above: it
 * imports no service, so nothing that needs a member version has to reach a handler for it.
 *
 * ONE function, because several places write or compare it and two spellings would
 * supersede a gate whose head never moved.
 */
export function pullRequestSubjectVersion(
  pr: {
    number: number;
    repo: { owner: string; name: string };
    checkRuns: Parameters<typeof liveRowsAtLatestSha>[0];
  },
  headSha?: string,
): string | null {
  const head = headSha ?? liveRowsAtLatestSha(pr.checkRuns)[0]?.commitSha;
  return head ? `${pr.repo.owner}/${pr.repo.name}#${pr.number}@${head}` : null;
}

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
