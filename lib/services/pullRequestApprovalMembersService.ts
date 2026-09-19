import type { GithubPullRequestQueueExit, Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import { deliveryMemberVersion } from '@/lib/approvalGates/deliverySetVersion';
import { unlandedOutcomeOutranksApproval } from '@/lib/approvalGates/gateSet';
import { classOfMergeRefusal, classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import { liveRowsAtLatestSha } from '@/lib/github/prCiState';
import { githubPullRequestMergeRefusalRepository } from '@/lib/repositories/githubPullRequestMergeRefusalRepository';
import type { PullRequestApprovalMemberDTO, PullRequestQueueExitDTO } from '@/lib/dto/approvalGate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// WHAT A RELOAD STILL KNOWS ABOUT AN APPROVE-AND-MERGE SET (Story MOTIR-4909 · MOTIR-5484 ·
// MOTIR-5613; Bug MOTIR-5650).
//
// Each member of one APPROVED `pull_request_approval` gate, with the facts that outlive the
// press's response —
//
//   · the PULL REQUEST the member names, while the card still delivers it;
//   · whether the press QUEUED it — the pull request carries a `queue:` outcome and has not
//     merged — so the row reads *Queued to merge* for as long as that is true;
//   · whether a RETRY is offered, which is a fact about the pull request rather than about a
//     second gate: the approval stands, and this member has no merge outcome yet;
//   · the merge queue's latest EXIT, and whether the row's verb is honest — the exit nobody has
//     put back, while the pull request is still at the head the gate named (MOTIR-5634), and
//     the approval it would act on has not already been spent on that outcome (MOTIR-5802).
//
// ⚠️ NO REFUSAL REASON: the press does not persist one.
//
// ⚠️ A LEAF ON PURPOSE. It imports repositories and nothing else, so `workItemsService` (the
// quick view) can read it without evaluating `pullRequestMergeService`'s git-provider and
// approval-handler graph — the module-cycle hazard that file documents.

const APPROVAL_KIND = 'pull_request_approval' as const;

type ApprovalGateRow = Awaited<ReturnType<typeof approvalGateRepository.findById>>;

async function approvedMembers(
  approval: ApprovalGateRow,
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<PullRequestApprovalMemberDTO[]> {
  if (
    !approval ||
    approval.kind !== APPROVAL_KIND ||
    (approval.state !== 'approved' && approval.state !== 'awaiting') ||
    approval.workItemId !== workItemId
  ) {
    return [];
  }
  // ⚠️ AN `awaiting` GATE IS READ TOO, AND IT IS THE RE-ASKED ONE (MOTIR-5802; §4 FOURTH
  // AMENDMENT, point 4). Its members carry the row verbs — *Queue again* / *Retry merge* —
  // and pressing one DECIDES this gate rather than reusing a spent approval, so the row
  // needs its id. Nothing was decided on it yet, so nothing it covers has been spent.
  const awaitingReask = approval.state === 'awaiting';
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx);
  const exits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    deliveries.map((row) => row.pullRequest.id),
    tx,
  );
  // The other way a merge fails to land, read the same way (MOTIR-5833): the host's
  // refusal at the press, which a reload would otherwise know nothing about.
  const refusals = await githubPullRequestMergeRefusalRepository.findLatestByPullRequests(
    deliveries.map((row) => row.pullRequest.id),
    tx,
  );
  return membersOf(approval.subjectVersion).map((member) => {
    const row = deliveries.find(
      (candidate) =>
        `${candidate.repo.owner}/${candidate.repo.name}` === member.repo &&
        candidate.pullRequest.number === member.number,
    );
    const pr = row?.pullRequest;
    const outcome = pr?.mergeOutcomeRef ?? null;
    const exit = pr ? (exits.get(pr.id) ?? null) : null;
    // An exit nobody has put back is Queue again's to offer, not Retry's (MOTIR-5634) — and
    // only while the pull request is still at the head the approval named, which is what
    // makes reusing the approval honest.
    const standingExit = exit !== null && exit.requeuedAt === null;
    // ⚠️ NO VERB ACTS ON A SPENT APPROVAL (MOTIR-5802; `approval-gates.md` §4 FOURTH
    // AMENDMENT, points 1 and 4). An un-landed outcome standing at the approved head —
    // of ANY disposition, NEUTRAL included — means the yes that sent these commits has
    // been used, so this gate offers no verb: the card is asked again on a fresh gate,
    // and it is THAT gate the row's press decides. On the re-asked (`awaiting`) gate
    // nothing has been spent, so the verb is offered and carries the gate's id.
    const open = pr !== undefined && pr.state === 'open' && !pr.merged;
    // A refusal STANDS while nothing superseded it, the head it names is still the
    // pull request's, and the pull request has not merged — the same shape an exit's
    // standing has, one source over (MOTIR-5833).
    const refusalRow = pr ? (refusals.get(pr.id) ?? null) : null;
    const refusalClass = refusalRow ? classOfMergeRefusal(refusalRow.code) : null;
    const headNow = pr ? liveRowsAtLatestSha([...pr.checkRuns])[0]?.commitSha : undefined;
    const standingRefusal =
      refusalRow !== null &&
      refusalClass !== null &&
      refusalRow.supersededAt === null &&
      headNow !== undefined &&
      refusalRow.headSha === headNow &&
      open;
    const spentOnThisOutcome =
      !awaitingReask &&
      ((standingExit &&
        unlandedOutcomeOutranksApproval({ at: exit.exitedAt }, approval.decidedAt ?? null)) ||
        (standingRefusal &&
          unlandedOutcomeOutranksApproval(
            { at: refusalRow.refusedAt },
            approval.decidedAt ?? null,
          )));
    // ⚠️ AND A CAN'T-LAND OUTCOME OFFERS NO VERB AT ALL (§4 FOURTH AMENDMENT, point 2):
    // the same commits cannot land however many times anyone says yes, so a button that
    // acts on them is a button guaranteed to fail. `motir fix` is the way forward.
    const cantLand =
      (standingExit && classOfQueueExit(exit.rawReason) === 'cant_land') ||
      (standingRefusal && refusalClass === 'cant_land');
    // A member the row's verb can act on is one carrying a standing outcome at the head
    // the gate names — an exit put back by *Queue again*, a refusal retried by *Retry
    // merge* (MOTIR-5834).
    const atApprovedHead =
      (standingExit || standingRefusal) &&
      row !== undefined &&
      deliveryMemberVersion(row) === member.subjectVersion;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: pr?.id ?? null,
      queued: pr !== undefined && !pr.merged && (outcome?.startsWith('queue:') ?? false),
      // A member Motir has not merged or queued yet is the one a person can try again —
      // under the approval that ATTEMPTED it. On the re-asked gate nothing has been
      // attempted yet, so there is nothing to retry: its verb is the enqueue below.
      retryable:
        !awaitingReask && pr !== undefined && !pr.merged && outcome === null && !standingExit,
      exit: exit ? toQueueExitDto(exit) : null,
      exitAtApprovedHead: atApprovedHead,
      requeueable: open && atApprovedHead && !spentOnThisOutcome && !cantLand,
      refusal:
        standingRefusal && refusalRow && refusalClass
          ? {
              code: refusalRow.code,
              landingClass: refusalClass,
              refusedAt: refusalRow.refusedAt.toISOString(),
              permission: refusalRow.permission,
            }
          : null,
      // Which gate the row's press DECIDES — the re-asked one, or null on the decided
      // gate, where the press carries out a decision already made.
      retryDecidesGateId: awaitingReask ? approval.id : null,
    };
  });
}

/** One merge-queue exit as a surface reads it (MOTIR-5632 · MOTIR-5633 · MOTIR-5634). */
export function toQueueExitDto(exit: GithubPullRequestQueueExit): PullRequestQueueExitDTO {
  return {
    rawReason: exit.rawReason,
    disposition: exit.disposition,
    headSha: exit.headSha,
    exitedAt: exit.exitedAt.toISOString(),
    requeuedAt: exit.requeuedAt?.toISOString() ?? null,
    failingCheckName: exit.failingCheckName,
    failingCheckUrl: exit.failingCheckUrl,
  };
}

export const pullRequestApprovalMembersService = {
  /** The members of ONE named gate — the item page's read, which already holds the gate.
   *  Empty for a gate that is not an approved approval gate on this card. */
  async listForGate(
    input: { workItemId: string; approvalGateId: string },
    ctx: ServiceContext,
  ): Promise<PullRequestApprovalMemberDTO[]> {
    return withWorkspaceContext(ctx, async (tx) => {
      const approval = await approvalGateRepository.findById(input.approvalGateId, tx);
      return approvedMembers(approval, input.workItemId, tx);
    });
  },

  /** The members of the card's LATEST approval gate, found here — the quick view's read,
   *  which draws no approval frame and so holds no gate id. Empty unless that gate is
   *  APPROVED. */
  async listForLatestGate(
    input: { workItemId: string },
    ctx: ServiceContext,
  ): Promise<PullRequestApprovalMemberDTO[]> {
    return withWorkspaceContext(ctx, async (tx) => {
      const approval = await approvalGateRepository.findLatestByWorkItem(
        input.workItemId,
        APPROVAL_KIND,
        tx,
      );
      return approvedMembers(approval, input.workItemId, tx);
    });
  },
};
