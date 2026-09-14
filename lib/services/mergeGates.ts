import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import type { GitProviderId } from '@/lib/git/types';
import { derivePrCiState, liveRowsAtLatestSha } from '@/lib/github/prCiState';
import {
  pullRequestMergeGateHandler,
  pullRequestSubjectVersion,
} from '@/lib/approvalGates/pullRequestMergeHandler';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  githubPullRequestRepository,
  type GithubPullRequestWithInstallation,
} from '@/lib/repositories/githubPullRequestRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { resolveRunTargetFor } from './runTarget';

// RAISE and WITHDRAW `pull_request_merge` gates (Story MOTIR-4882 · MOTIR-5515;
// `docs/decisions/approval-gates.md` §4's second amendment, decisions 1–3).
//
// A merge gate is ONE question per pull request — *merge these commits?* — asked on
// the RUN TARGET, and only once CI has judged the whole delivery set green. It is
// raised in the caller's transaction and withdrawn (`superseded`) the moment what it
// asks about changes: the head moves, the pull request closes, or its delivery row
// leaves the card.
//
// ⚠️ EVERY FUNCTION HERE WRITES INSIDE A TRANSACTION IT IS HANDED. The raise runs in
// the SAME transaction as the `implemented → in_review` write, so a card never reaches
// review without its gates, and a gate is never left over a status write that rolled
// back.
//
// ⚠️ THE HANDLER IS IMPORTED DIRECTLY, not through `handlerFor`. The registry imports
// the design handler, which imports `workItemsService`, which imports the CI promotion
// that calls this module — a cycle at module-evaluation time. The handler module
// imports no service, and it IS the registered `pull_request_merge` handler
// (`tests/approval-gate-merge-kind.test.ts` pins the identity).

const KIND = 'pull_request_merge' as const;

/** One auto merge the promotion owes AFTER it commits (MOTIR-5518). */
export interface AutoMergeRequest {
  pullRequestId: string;
  headSha: string;
}

/**
 * Is this pull request a merge candidate NOW — open, on a provider that can merge, and
 * green at its latest head? The ONE statement both modes ask: a gate in `manual`, a
 * job in `auto`. Re-asked per member because a push can land between the verdict and
 * the transaction asking.
 */
function isMergeCandidate(
  pr: GithubPullRequestWithInstallation | null,
): pr is GithubPullRequestWithInstallation {
  return (
    pr !== null &&
    pr.state === 'open' &&
    !pr.merged &&
    providerSupportsMerge(getGitProvider(pr.repo.provider as GitProviderId)) &&
    derivePrCiState(pr.checkRuns) === 'passing'
  );
}

/**
 * SETTLE A GREEN VERDICT on a card — the one hook the CI promotion calls, in its own
 * transaction, for both modes (MOTIR-5515 · MOTIR-5518):
 *
 *   - `manual` → raise the gates ({@link raiseMergeGates}) and owe nothing after commit;
 *   - `auto` → raise NOTHING, and return the merges to dispatch once the transaction
 *     has committed — a job enqueued before the commit could run against a promotion
 *     that then rolled back.
 *
 * Either way only the RUN TARGET's members count, and only merge candidates.
 */
export async function settleGreenVerdict(
  args: { item: WorkItem; pullRequestIds: readonly string[] },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<AutoMergeRequest[]> {
  if (args.pullRequestIds.length === 0) return [];
  const mode = await projectRepository.findPrMergeMode(args.item.projectId, tx);
  if (mode?.prMergeMode === 'manual') {
    await raiseMergeGates(args, ctx, tx);
    return [];
  }
  if (mode?.prMergeMode !== 'auto') return [];
  if ((await resolveRunTargetFor(args.item, tx)).kind === 'ancestor') return [];

  const requests: AutoMergeRequest[] = [];
  for (const pullRequestId of args.pullRequestIds) {
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    if (!isMergeCandidate(pr)) continue;
    const headSha = liveRowsAtLatestSha(pr.checkRuns)[0]?.commitSha;
    if (headSha) requests.push({ pullRequestId: pr.id, headSha });
  }
  return requests;
}

/**
 * Raise an `awaiting` merge gate for each delivering pull request that is a merge
 * candidate NOW. The caller has already judged the card's delivery set green and holds
 * the card's row lock, which serialises two raises for one card: the second reads the
 * first's committed gates and raises nothing.
 *
 * A pull request is skipped — and that is the answer, not an error — when:
 *   - the project merges automatically (`prMergeMode` is not `manual`);
 *   - the card is not the run target (an ancestor's record covers it);
 *   - it already has an awaiting merge gate on this card;
 *   - it is closed or merged;
 *   - its provider cannot merge (GitLab until MOTIR-4883);
 *   - its own checks are not green at its latest head — re-asked per member, because
 *     a push can land between the verdict and this transaction;
 *   - no check has named its head, so there is no commit to pin the question to.
 *
 * Returns how many gates it raised.
 */
export async function raiseMergeGates(
  args: { item: WorkItem; pullRequestIds: readonly string[] },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const { item } = args;
  if (args.pullRequestIds.length === 0) return 0;

  const mode = await projectRepository.findPrMergeMode(item.projectId, tx);
  if (mode?.prMergeMode !== 'manual') return 0;
  if ((await resolveRunTargetFor(item, tx)).kind === 'ancestor') return 0;

  const awaiting = new Set(
    (await approvalGateRepository.findAwaitingByWorkItem(item.id, tx))
      .filter((gate) => gate.kind === KIND)
      .map((gate) => gate.subjectId),
  );

  let raised = 0;
  for (const pullRequestId of args.pullRequestIds) {
    if (awaiting.has(pullRequestId)) continue;
    const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    if (!isMergeCandidate(pr)) continue;
    const subjectVersion = pullRequestSubjectVersion(pr);
    if (!subjectVersion) continue;

    await approvalGateRepository.create(
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        kind: KIND,
        subjectId: pr.id,
        subjectVersion,
        routedToId: pullRequestMergeGateHandler.routeTo({ item, ctx, tx }),
      },
      tx,
    );
    raised += 1;
  }
  return raised;
}

/**
 * WITHDRAW on a HEAD MOVE: supersede every awaiting merge gate on this pull request
 * whose `subjectVersion` names a head other than the current one.
 *
 * `headSha` is the head a `pull_request` delivery carries; without one the head is the
 * latest check run's commit — the same rule the version was written with, so the two
 * cannot disagree about which commit is current. Nothing is superseded when no head
 * is known. Returns the count.
 */
export async function withdrawMergeGatesOnHeadMove(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
  headSha?: string,
): Promise<number> {
  // The ordinary CI event finds no gate at all, and pays one read for it.
  const awaiting = await approvalGateRepository.findAwaitingBySubject(KIND, pullRequestId, tx);
  if (awaiting.length === 0) return 0;
  const pr = await githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
  if (!pr) return 0;
  const current = pullRequestSubjectVersion(pr, headSha);
  if (!current) return 0;
  return approvalGateRepository.supersedeAwaitingBySubject(
    { kind: KIND, subjectId: pullRequestId, exceptVersion: current },
    tx,
  );
}

/**
 * WITHDRAW on CLOSE, merged or not: a closed pull request can be merged by nobody. It
 * also retires a gate a crash left `awaiting` between a merge and its decision — the
 * merge webhook arrives, and the question goes with it.
 */
export async function withdrawMergeGatesOnClose(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  return approvalGateRepository.supersedeAwaitingBySubject(
    { kind: KIND, subjectId: pullRequestId },
    tx,
  );
}

/**
 * WITHDRAW on UNLINK: the pull request's delivery row left this card, so this card's
 * gate for it goes. Only this card's — the same pull request may still deliver
 * another card, whose gate is still a real question.
 */
export async function withdrawMergeGateOnUnlink(
  workItemId: string,
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  return approvalGateRepository.supersedeAwaitingBySubject(
    { kind: KIND, subjectId: pullRequestId, workItemId },
    tx,
  );
}
