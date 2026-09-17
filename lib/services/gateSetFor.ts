import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { deliveryMemberVersion } from '@/lib/approvalGates/deliverySetVersion';
import { resolveGateSet, type GateSet, type GateSetMember } from '@/lib/approvalGates/gateSet';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { derivePrCiState } from '@/lib/github/prCiState';
import { mergeCandidateHead } from './mergeGates';
import { workflowsService } from './workflowsService';

// THE PREDICATE'S ONE LOADER (Story MOTIR-5652 · Subtask MOTIR-5662) — reads the
// facts `resolveGateSet` is a function of, for one card, on a transaction it is
// handed.
//
// ⚠️ THE SPLIT IS THE POINT, not ceremony. `lib/approvalGates/gateSet.ts` is the
// RULE and is pure, so it can be read against AMENDMENT 6 line by line and tested
// without a fixture. This module is the READ, and it is the only place the rule's
// inputs are gathered — so a caller cannot answer half of the question inline and
// ask the predicate the other half, which is exactly how MOTIR-5603, MOTIR-5604
// and MOTIR-5652 were each written by somebody being locally careful.
//
// ⚠️ IT OPENS NO TRANSACTION AND TAKES NO LOCK. Every caller already holds the
// card's row lock for its own write; adding one here would change lock ordering in
// four places at once. Every read is on the caller's `tx`, so what the predicate
// sees is what that transaction will write against.

/** What a raise did, or why it did not — enough for a caller to log a true sentence. */
export interface GateSetForResult extends GateSet {
  /**
   * The members that could NOT be merged now, with the reason visible in the row.
   * Empty when the set is mergeable or when the card delivers nothing.
   *
   * MOTIR-5604's `console.warn` needs this: the predicate answers *no merge gate
   * is owed*, and a person looking at an unapprovable card needs to know WHICH
   * pull request is why. The rule stays in the predicate; the naming stays here.
   */
  readonly blockedMembers: ReadonlyArray<{
    pullRequestId: string;
    state: string;
    merged: boolean;
    ciState: string | null;
  }>;
}

/**
 * WHICH GATES this card should be asking, read from the database and decided by
 * {@link resolveGateSet}.
 *
 * Six reads, all on `tx`: the current design result, the latest gate of each kind,
 * the delivery set with its check runs, the project's merge mode, and the
 * project's terminal status keys.
 */
export async function gateSetFor(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<GateSetForResult> {
  const [currentDesign, latestDesignGate, latestMergeGate, deliveries, mode, terminalByProject] =
    await Promise.all([
      designEvidenceRepository.findCurrentByWorkItem(item.id, tx),
      approvalGateRepository.findLatestByWorkItem(item.id, 'design_result', tx),
      approvalGateRepository.findLatestByWorkItem(item.id, 'pull_request_approval', tx),
      workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
      projectRepository.findPrMergeMode(item.projectId, tx),
      workflowsService.getTerminalStatusKeysByProjects([item.projectId], item.workspaceId, tx),
    ]);

  const members: GateSetMember[] = [];
  const blockedMembers: GateSetForResult['blockedMembers'][number][] = [];
  for (const delivery of deliveries) {
    const head = mergeCandidateHead({ ...delivery.pullRequest, repo: delivery.repo });
    if (!head) {
      blockedMembers.push({
        pullRequestId: delivery.githubPullRequestId,
        state: delivery.pullRequest.state,
        merged: delivery.pullRequest.merged,
        ciState: derivePrCiState(delivery.pullRequest.checkRuns),
      });
    }
    members.push({
      memberVersion: deliveryMemberVersion(delivery, head ?? undefined),
      isMergeCandidate: head !== null,
    });
  }

  const set = resolveGateSet({
    currentDesignEvidence: currentDesign
      ? { id: currentDesign.id, commitSha: currentDesign.commitSha }
      : null,
    latestDesignGate,
    latestMergeGate,
    members,
    prMergeMode: mode?.prMergeMode ?? null,
    cardIsTerminal: isTerminalStatus(item, terminalByProject),
    workItemId: item.id,
  });

  return { ...set, blockedMembers };
}
