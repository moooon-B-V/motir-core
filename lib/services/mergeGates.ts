import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import type { GitProviderId } from '@/lib/git/types';
import { derivePrCiState, liveRowsAtLatestSha } from '@/lib/github/prCiState';
import {
  githubPullRequestRepository,
  type GithubPullRequestWithInstallation,
} from '@/lib/repositories/githubPullRequestRepository';
import { designApprovalStandsForMerge, designHoldsMerge } from '@/lib/approvalGates/gateSet';
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
 *
 * ⚠️ AND A DRAFT IS NOT A CANDIDATE (MOTIR-5699). A draft is its author saying *not
 * ready*, and the host refuses to merge one — so a green draft that counted here put an
 * approve-and-merge question on somebody's To approve that could only fail when
 * pressed. The lifecycle seam has refused drafts since MOTIR-4968; this is the same
 * fact reaching the gate. Only `true` refuses: `null` is a row written before
 * MOTIR-5002 persisted the flag, and inventing draft-ness for it would strand a card
 * nobody drafted.
 */
export function mergeCandidateHead(
  pr:
    | (Pick<GithubPullRequestWithInstallation, 'state' | 'merged' | 'draft' | 'checkRuns'> & {
        repo: { provider: string };
      })
    | null,
): string | null {
  if (
    pr === null ||
    pr.state !== 'open' ||
    pr.merged ||
    pr.draft === true ||
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
  const [currentDesign, latestDesignGate, latestMergeGate] = await Promise.all([
    designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    approvalGateRepository.findLatestByWorkItem(workItemId, 'design_result', tx),
    approvalGateRepository.findLatestByWorkItem(workItemId, 'pull_request_approval', tx),
  ]);
  // The same ONE-TIME clause the predicate applies: once a merge gate has existed,
  // the commits are the merge gate's question and a later green is not this
  // approval's to carry (MOTIR-5666).
  return latestMergeGate === null && designApprovalStandsForMerge(currentDesign, latestDesignGate);
}

/**
 * {@link designHoldsMerge}, read from the card's own rows — whether an unanswered design
 * holds this card's merge (Bug MOTIR-5762). Exported for the review sync, the other merge
 * path that does not go through the design's own press.
 */
export async function designResultHoldsMerge(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const [currentDesign, latestDesignGate] = await Promise.all([
    designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    approvalGateRepository.findLatestByWorkItem(workItemId, 'design_result', tx),
  ]);
  return designHoldsMerge(currentDesign, latestDesignGate);
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
  } else if (await designResultHoldsMerge(args.item.id, tx)) {
    // ⚠️ AN UNANSWERED DESIGN HOLDS AN AUTOMATIC MERGE (Bug MOTIR-5762; `design-result.md`
    // AMENDMENT 6 Q1). §7a's *"`auto` means no gate"* is about the MERGE gate — the design
    // gate is raised at publish in both modes, and it is the PRIMARY question the merge
    // follows. Awaiting, sent back, or approved for a result since superseded all hold.
    // The merge follows the approval: on the next green verdict, or at once when the press
    // lands on a set that is already green (`pullRequestMergeService`).
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
