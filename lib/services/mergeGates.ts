import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import type { GitProviderId } from '@/lib/git/types';
import { derivePrCiState, liveRowsAtLatestSha } from '@/lib/github/prCiState';
import {
  githubPullRequestRepository,
  type GithubPullRequestWithInstallation,
} from '@/lib/repositories/githubPullRequestRepository';
import { designApprovalStandsForMerge } from '@/lib/approvalGates/gateSet';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { resolveRunTargetFor } from './runTarget';

// SETTLE a card's green verdict (Story MOTIR-4882 · MOTIR-5518; MOTIR-5603 · MOTIR-5611).
//
// ⚠️ THIS MODULE NO LONGER RAISES A GATE. A card has ONE approve-to-merge gate — the
// `pull_request_approval` gate over its delivery set, raised by `pullRequestApprovalGates`
// — and approving it merges every pull request the card delivers. The per-pull-request
// `pull_request_merge` gate is retired, with its raise and its three withdraw paths
// (`docs/decisions/approval-gates.md` §8's SECOND AMENDMENT, MOTIR-5609, decisions 1-5).
//
// What survives here is the half BOTH merge modes share: the one statement of whether a
// pull request is a merge candidate right now, and the `auto` arm that returns the merges
// the promotion owes after it commits. In `manual` the answer is now "nothing to do" —
// the gate that asks the question lives elsewhere.

/** One auto merge the promotion owes AFTER it commits (MOTIR-5518). */
export interface AutoMergeRequest {
  pullRequestId: string;
  headSha: string;
}

/**
 * The HEAD a merge candidate would be merged at, or `null` when the pull request is not
 * a merge candidate NOW — open, on a provider that can merge, and green at its latest
 * head. Asked by the `auto` arm below and by the approve-and-merge gate's own raise, so
 * both modes read one statement of it.
 *
 * ⚠️ A green pull request always HAS a head: `derivePrCiState` answers `passing` only
 * over a non-empty set of rows at the latest sha, so the head is read from that same
 * set rather than checked for separately.
 */
export function mergeCandidateHead(
  pr:
    | (Pick<GithubPullRequestWithInstallation, 'state' | 'merged' | 'checkRuns'> & {
        repo: { provider: string };
      })
    | null,
): string | null {
  if (
    pr === null ||
    pr.state !== 'open' ||
    pr.merged ||
    !providerSupportsMerge(getGitProvider(pr.repo.provider as GitProviderId)) ||
    derivePrCiState(pr.checkRuns) !== 'passing'
  ) {
    return null;
  }
  return liveRowsAtLatestSha(pr.checkRuns)[0]!.commitSha;
}

/**
 * SETTLE A GREEN VERDICT on a card — the one hook the CI promotion calls, in its own
 * transaction, for both modes (MOTIR-5518 · MOTIR-5611):
 *
 *   - `manual` → raise NOTHING here. The card's single approve-to-merge gate is raised
 *     by `raisePullRequestApprovalGate`, in the same transaction, over the same set;
 *   - `auto` → raise nothing either, and return the merges to dispatch once the
 *     transaction has committed — a job enqueued before the commit could run against a
 *     promotion that then rolled back.
 *
 * Either way only the RUN TARGET's members count, and only merge candidates.
 */
/** {@link designApprovalStandsForMerge}, read from the card's own rows. */
async function designApprovalHolds(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const [currentDesign, latestDesignGate] = await Promise.all([
    designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    approvalGateRepository.findLatestByWorkItem(workItemId, 'design_result', tx),
  ]);
  return designApprovalStandsForMerge(currentDesign, latestDesignGate);
}

export async function settleGreenVerdict(
  args: { item: WorkItem; pullRequestIds: readonly string[] },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<AutoMergeRequest[]> {
  void ctx;
  if (args.pullRequestIds.length === 0) return [];
  const mode = await projectRepository.findPrMergeMode(args.item.projectId, tx);
  if (mode?.prMergeMode === 'manual') {
    // ⚠️ THE MERGE A DESIGN APPROVAL IS ALREADY HOLDING (Story MOTIR-5652 ·
    // Subtask MOTIR-5664; `design-result.md` AMENDMENT 6 Q4). The design gate
    // rises on PUBLISH and the merge gate on GREEN, so the primary can be
    // pressed before CI has spoken — and Q4 settles that the press is not
    // refused: *"the decision stands and the merge follows on the next green
    // verdict, with no second press."* This IS that next green.
    //
    // The predicate has already answered *no merge gate is owed* for the same
    // reason, so without this arm the card would go green holding an approval
    // nobody carried out. Both readers ask the one question, in
    // `designApprovalStandsForMerge`.
    if (!(await designApprovalHolds(args.item.id, tx))) return [];
  } else if (mode?.prMergeMode !== 'auto') {
    return [];
  } else if ((await resolveRunTargetFor(args.item, tx)).kind === 'ancestor') {
    return [];
  }

  const requests: AutoMergeRequest[] = [];
  for (const pullRequestId of args.pullRequestIds) {
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    const headSha = mergeCandidateHead(pr);
    if (pr && headSha) requests.push({ pullRequestId: pr.id, headSha });
  }
  return requests;
}
