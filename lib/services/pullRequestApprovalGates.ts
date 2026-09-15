import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { mergeCandidateHead } from './mergeGates';
import { resolveRunTargetFor } from './runTarget';

// RAISE and WITHDRAW the `pull_request_approval` gate (Story MOTIR-4909 · MOTIR-5482;
// `docs/decisions/approval-gates.md` §8's amendment, decisions 1, 3 and 4).
//
// ONE question per card — *are these commits right?* — asked on the RUN TARGET once CI has
// judged its whole delivery set green, in a `manual` project. It is raised in the SAME
// transaction as the merge gates (the promotion's `implemented → in_review` write, or the
// re-raise for a card already in review), and withdrawn (`superseded`) the moment the set it
// asked about changes: a member's head moves, a member closes, or a delivery row joins or
// leaves the card.
//
// ⚠️ EVERY FUNCTION HERE WRITES INSIDE A TRANSACTION IT IS HANDED, and the raise relies on
// its caller holding the CARD's row lock. That lock is what serialises two green events for
// one card: the second reads the first's committed gate and raises nothing — so a lost race
// is a no-op, never a unique-index violation that would abort the caller's transaction.
//
// ⚠️ IT IMPORTS NO HANDLER. The handler module imports `workItemsService`, which imports the
// CI promotion that calls this module; the version and routing it needs live in
// service-free modules instead (`deliverySetVersion.ts`, `routing.ts`).

const KIND = 'pull_request_approval' as const;

/**
 * Raise ONE `awaiting` approve-and-merge gate on `item` when all of these hold, and answer
 * whether it did:
 *   - the project's `prMergeMode` is `manual` — in `auto` Motir merges with no person;
 *   - `item` is the run target — a child an ancestor's record covers gets none;
 *   - it has no `awaiting` gate of this kind already;
 *   - it delivers at least one pull request, and EVERY member is a merge candidate now:
 *     open, on a provider that can merge, and green at its latest head. Re-asked here,
 *     because a push can land between the verdict and this transaction.
 *
 * `subjectId` is the card's own id, and `subjectVersion` names every member's head.
 */
export async function raisePullRequestApprovalGate(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const mode = await projectRepository.findPrMergeMode(item.projectId, tx);
  if (mode?.prMergeMode !== 'manual') return false;
  if ((await resolveRunTargetFor(item, tx)).kind === 'ancestor') return false;

  const awaiting = await approvalGateRepository.findAwaitingByWorkItem(item.id, tx);
  if (awaiting.some((gate) => gate.kind === KIND)) return false;

  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
  if (deliveries.length === 0) return false;
  const members: string[] = [];
  for (const delivery of deliveries) {
    const head = mergeCandidateHead({ ...delivery.pullRequest, repo: delivery.repo });
    if (!head) return false;
    members.push(deliveryMemberVersion(delivery, head)!);
  }

  await approvalGateRepository.create(
    {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
      kind: KIND,
      subjectId: item.id,
      subjectVersion: deliverySetVersion(members),
      routedToId: routingTargetId(item),
    },
    tx,
  );
  return true;
}

/**
 * WITHDRAW on a HEAD MOVE: for every card this pull request delivers, supersede its awaiting
 * approve-and-merge gate when the set's CURRENT version differs from the one the gate asked
 * about.
 *
 * `headSha` is the head a `pull_request` delivery carries; without one each member's head is
 * its latest check run's commit — the rule the version was written with, so a late row for
 * an OLD commit withdraws nothing. Nothing is superseded while any member's head is unknown.
 * Returns the count.
 */
export async function withdrawPullRequestApprovalGatesOnHeadMove(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
  headSha?: string,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    const gate = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).find(
      (row) => row.kind === KIND,
    );
    if (!gate) continue;
    const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx);
    const current = deliverySetVersion(
      deliveries.map((delivery) =>
        deliveryMemberVersion(
          delivery,
          delivery.githubPullRequestId === pullRequestId ? headSha : undefined,
        ),
      ),
    );
    if (!current || current === gate.subjectVersion) continue;
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(workItemId, KIND, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on CLOSE, merged or not: a closed member means the set the question was asked
 * about is no longer the set anybody can merge. Every card the pull request delivers loses
 * its awaiting gate; a gate already decided is untouched.
 */
export async function withdrawPullRequestApprovalGatesOnClose(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(workItemId, KIND, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on a SET CHANGE: a delivery row joined or left this card, so the set its gate
 * asked about is not the set it now carries. Called by every writer of `work_item_delivery`
 * (`githubPullRequestService`'s two link arms and two unlink arms), only when the write
 * actually changed the set.
 */
export async function withdrawPullRequestApprovalGateOnSetChange(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  return approvalGateRepository.supersedeAwaitingByWorkItem(workItemId, KIND, tx);
}
