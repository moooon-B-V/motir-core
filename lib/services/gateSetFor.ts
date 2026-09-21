import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { deliveryMemberVersion } from '@/lib/approvalGates/deliverySetVersion';
import {
  primaryApprovalStandsForMerge,
  resolveGateSet,
  type AwaitableGateKind,
  type GateSet,
  type GateSetMember,
} from '@/lib/approvalGates/gateSet';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import { decisionMembersOf } from '@/lib/approvalGates/decisionApprovalHandler';
import { decisionIdentityOf } from '@/lib/approvalGates/decisionSubject';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { queueExitStandsAtHead } from '@/lib/workItems/deliverySet';
import { derivePrCiState, liveRowsAtLatestSha } from '@/lib/github/prCiState';
import {
  classOfMergeRefusal,
  classOfQueueExit,
  type LandingClass,
} from '@/lib/mergeQueue/queueExit';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { githubPullRequestMergeRefusalRepository } from '@/lib/repositories/githubPullRequestMergeRefusalRepository';
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

/**
 * A head this TRANSACTION knows about and the stored check runs do not — the
 * `synchronize` delivery's own sha. Threaded so a re-ask after a head-move
 * withdrawal cannot raise a gate over the commits it just retired.
 */
export interface MovedHead {
  pullRequestId: string;
  /** The delivery's head, or undefined when it carried none. */
  headSha: string | undefined;
}

/** What the CALLING EVENT knows that the card's rows do not yet say. */
export interface GateSetSignals {
  movedHead?: MovedHead;
}

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
 * Nine reads, all on `tx`: the current design result and receipt, the latest gate of each
 * kind (the decision's only when the card asks that question), the delivery set with its
 * check runs, the project's merge mode, and the project's terminal status keys.
 */
export async function gateSetFor(
  item: WorkItem,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<GateSetForResult> {
  const asksDecision = asksTheDecisionQuestion(item);
  const [
    currentDesign,
    latestDesignGate,
    currentReceipt,
    latestAcceptanceGate,
    latestMergeGate,
    latestDecisionGate,
    deliveries,
    mode,
    terminalByProject,
  ] = await Promise.all([
    designEvidenceRepository.findCurrentByWorkItem(item.id, tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'design_result', tx),
    // MOTIR-5789 — a STORY's acceptance receipt and its latest gate, loaded here in the
    // predicate's ONE loader so no caller answers half the question itself.
    acceptanceEvidenceRepository.findCurrentByWorkItem(item.id, tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'acceptance_result', tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'pull_request_approval', tx),
    // Only a card that asks the decision question reads its gate (clause 10), so every
    // other card's reads — and its answer — are what they were before the kind existed.
    asksDecision
      ? approvalGateRepository.findLatestByWorkItem(item.id, 'decision_approval', tx)
      : Promise.resolve(null),
    workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    projectRepository.findPrMergeMode(item.projectId, tx),
    workflowsService.getTerminalStatusKeysByProjects([item.projectId], item.workspaceId, tx),
  ]);

  const members: GateSetMember[] = [];
  const blockedMembers: GateSetForResult['blockedMembers'][number][] = [];
  for (const delivery of deliveries) {
    const candidate = mergeCandidateHead({ ...delivery.pullRequest, repo: delivery.repo });
    // ⚠️ A HEAD THIS TRANSACTION KNOWS ABOUT AND THE ROWS DO NOT (MOTIR-5663).
    // `mergeCandidateHead` reads the CHECK RUNS, so a `synchronize` that has not
    // yet produced a check row still looks green at the OLD commit. The delivery
    // that carried the move knows better, and it is the same override
    // `withdrawPullRequestApprovalGatesOnHeadMove` already threads into
    // `deliveryMemberVersion` — without it the re-ask would raise a fresh gate
    // over exactly the commits the withdrawal just retired.
    const movedHead = signals.movedHead;
    const moved =
      movedHead !== undefined &&
      movedHead.pullRequestId === delivery.githubPullRequestId &&
      movedHead.headSha !== candidate;
    const head = moved ? null : candidate;
    if (!head) {
      blockedMembers.push({
        pullRequestId: delivery.githubPullRequestId,
        state: delivery.pullRequest.state,
        merged: delivery.pullRequest.merged,
        ciState: derivePrCiState(delivery.pullRequest.checkRuns),
      });
    }
    members.push({
      memberVersion: deliveryMemberVersion(
        delivery,
        moved ? signals.movedHead!.headSha : (head ?? undefined),
      ),
      isMergeCandidate: head !== null,
      merged: delivery.pullRequest.merged,
    });
  }

  // ⚠️ AN UN-LANDED OUTCOME STANDING AT A MEMBER'S HEAD RE-ASKS THE MERGE, AND ITS
  // CLASS SAYS WHETHER IT ASKS AT ALL (§4 FOURTH AMENDMENT, points 2–3; MOTIR-5802 ·
  // MOTIR-5805). Read over EVERY disposition, not only the failures the promotion hold
  // reads: a NEUTRAL removal spends the approval exactly as a failure does (Yue,
  // 2026-09-19: *"re-ask too"*), so it must reach the predicate. One indexed read, and
  // nothing for nearly every card.
  const latestExits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    deliveries.map((delivery) => delivery.githubPullRequestId),
    tx,
  );
  // ⚠️ AND A HOST REFUSAL IS THE OTHER SOURCE (MOTIR-5833). The queue's removal and the
  // refusal at the press are two ways the SAME approval fails to land, so both feed the
  // one predicate; a refusal stands while nothing superseded it and the head it names is
  // still the member's.
  const latestRefusals = await githubPullRequestMergeRefusalRepository.findLatestByPullRequests(
    deliveries.map((delivery) => delivery.githubPullRequestId),
    tx,
  );
  const standingOutcomes = deliveries.flatMap((delivery) => {
    const head = liveRowsAtLatestSha([...delivery.pullRequest.checkRuns])[0]?.commitSha;
    const outcomes: { at: Date; landingClass: LandingClass }[] = [];
    const exit = latestExits.get(delivery.githubPullRequestId);
    // The RULE is `deliverySet.ts`'s `queueExitStandsAtHead` — the promotion hold's own
    // twin, one disposition wider — so the two readers cannot disagree about which exit
    // still describes the code.
    if (queueExitStandsAtHead(exit, head)) {
      outcomes.push({ at: exit!.exitedAt, landingClass: classOfQueueExit(exit!.rawReason) });
    }
    const refusal = latestRefusals.get(delivery.githubPullRequestId);
    const refusalClass = refusal ? classOfMergeRefusal(refusal.code) : null;
    if (
      refusal &&
      refusalClass !== null &&
      refusal.supersededAt === null &&
      head &&
      refusal.headSha === head &&
      !delivery.pullRequest.merged
    ) {
      outcomes.push({ at: refusal.refusedAt, landingClass: refusalClass });
    }
    return outcomes;
  });
  // The LATEST outcome is the one the question is about; an older one is history.
  const standingUnlandedOutcome =
    standingOutcomes.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;

  const set = resolveGateSet({
    currentDesignEvidence: currentDesign
      ? { id: currentDesign.id, commitSha: currentDesign.commitSha }
      : null,
    currentReceipt: currentReceipt
      ? { id: currentReceipt.id, commitSha: currentReceipt.commitSha }
      : null,
    latestAcceptanceGate,
    primaryApprovalStandsForMerge: primaryApprovalStandsForMerge({
      currentDesign,
      latestDesignGate,
      currentReceipt,
      latestAcceptanceGate,
    }),
    latestDesignGate,
    latestMergeGate,
    members,
    prMergeMode: mode?.prMergeMode ?? null,
    cardIsTerminal: isTerminalStatus(item, terminalByProject),
    workItemId: item.id,
    standingUnlandedOutcome,
    // THE DECISION QUESTION (MOTIR-5677) — read from the SAME delivery rows as the
    // merge question, off the capture MOTIR-5674 writes, so the two can never be about
    // different pull requests and no host is called.
    ...(asksDecision
      ? {
          decision: {
            identity: decisionIdentityOf(decisionMembersOf(deliveries)),
            latestGate: latestDecisionGate,
          },
        }
      : {}),
  });

  return { ...set, blockedMembers };
}

/**
 * RAISE WHATEVER THE CARD SHOULD BE ASKING AND IS NOT, in the caller's transaction.
 * Returns the kinds it created, in the order {@link resolveGateSet} names them.
 *
 * ⚠️ THE ONE PLACE A GATE ROW IS CREATED (Story MOTIR-5652 · Subtask MOTIR-5663).
 * `raisePullRequestApprovalGate` is a thin wrapper over this, and the withdrawers
 * call it straight after superseding — which is the structural half of this level.
 * Each withdrawer answers a narrow and correct question (*this head moved, so the
 * gate about the old head is stale*) and none was ever in a position to ask *and
 * what should the card have instead?* — so a question retired for an excellent
 * reason simply stopped existing. MOTIR-5604 is that, already paid for once, at
 * one site, with six others behaving the same way.
 *
 * ⚠️ IT DOES NOT SUPERSEDE. Reconciliation is deliberately one-directional here:
 * each withdrawer already knows which question IT is retiring and why, and a
 * general "supersede everything not in the set" would take that cause away and
 * make one site's event able to retire another kind's question. Raising what is
 * missing is safe from any caller; retiring stays where the cause is known.
 *
 * ⚠️ IT ASKS FOR NO HANDLER. `designResultHandler` imports `workItemsService`,
 * which imports the CI promotion that calls this module. Both registered kinds
 * route by ADR §2's `assigneeId ?? reporterId` — which is all `routeTo` does — so
 * the shared `routingTargetId` is the same answer without the cycle.
 */
export async function reconcileGatesFor(
  item: WorkItem,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<AwaitableGateKind[]> {
  const set = await gateSetFor(item, tx, signals);
  if (set.awaited.length === 0) return [];

  const awaiting = await approvalGateRepository.findAwaitingByWorkItem(item.id, tx);
  const raised: AwaitableGateKind[] = [];
  for (const owed of set.awaited) {
    // The card's row lock (every caller holds it) is what serialises two events
    // for one card; this read is the second of them seeing the first's committed
    // row, so a lost race is a no-op rather than a unique-index violation that
    // would abort the caller's transaction.
    if (awaiting.some((gate) => gate.kind === owed.kind)) continue;
    await approvalGateRepository.create(
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        kind: owed.kind,
        subjectId: owed.subjectId,
        subjectVersion: owed.subjectVersion,
        routedToId: routingTargetId(item),
      },
      tx,
    );
    raised.push(owed.kind);
  }
  return raised;
}
