import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { gateSetFor, reconcileGatesFor, type GateSetSignals } from './gateSetFor';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';

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
const ACCEPTANCE_KIND = 'acceptance_result' as const;

/**
 * Raise the card's `awaiting` approve-and-merge gate when {@link gateSetFor} says it is
 * owed and the card does not already hold one, and answer whether it did.
 *
 * ⚠️ IT NO LONGER DECIDES ANYTHING (Story MOTIR-5652 · Subtask MOTIR-5662). Every
 * condition that used to be a line in this function is now a case inside
 * `resolveGateSet`, which is the only thing that knows what a card SHOULD hold. Where
 * each one went, because a condition that quietly evaporates in a conversion is a
 * previously-paid-for bug arriving again with a green suite behind it:
 *
 * · `prMergeMode !== 'manual'` → the predicate's `prMergeMode` input.
 * · every member is a merge candidate → the members' `isMergeCandidate`, which is
 *   {@link mergeCandidateHead}'s answer. **MOTIR-5604's refusal**, and its
 *   `console.warn` is still here — improved, because the loader hands back WHICH
 *   member is not a candidate instead of stopping at the first.
 * · the same commits are never asked about twice → `alreadyDecided` over the set
 *   version. **MOTIR-5632's rule**, unchanged in content.
 * · at least one delivery → an empty set has no version, so no merge gate is owed.
 * · no `awaiting` gate of this kind already → still HERE, and deliberately: it is not
 *   a rule about what the card should hold, it is this writer not writing a row that
 *   exists. The predicate answers *what should be awaiting*; two callers racing on
 *   the same answer is what the card's row lock and this check resolve.
 *
 * ⚠️ AND THE RUN-TARGET REFUSAL IS GONE — `if (resolveRunTargetFor(item).kind ===
 * 'ancestor') return false`, one of MOTIR-5652's two root causes. `resolveRunTargetFor`
 * answers *whose How to test is this*, which is a true and useful question; it was
 * never an answer to *does this card have something to decide*. In a parent run the
 * How-to-test record is written once onto the PARENT, so every child resolved to
 * `ancestor` and raised nothing, while the parent's own promotion was skipped by
 * `ContainerHasOpenChildrenError` — no gate anywhere. `resolveRunTargetFor` itself is
 * untouched.
 */
export async function raisePullRequestApprovalGate(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const set = await gateSetFor(item, tx);
  if (!set.awaited.some((gate) => gate.kind === KIND) && set.blockedMembers.length > 0) {
    // Every caller has just judged this set green, so a member that is not a merge
    // candidate is the refusal worth naming (MOTIR-5604): the card goes unapprovable
    // until the next green, and nothing else on the page says why.
    console.warn('[pullRequestApprovalGates] raise refused: a member is not a merge candidate', {
      workItemId: item.id,
      members: set.blockedMembers,
    });
  }
  return (await reconcileGatesFor(item, tx)).includes(KIND);
}

/**
 * Ask the predicate what `workItemId` should hold NOW and raise it — the statement
 * that runs immediately after each withdrawal below (Subtask MOTIR-5663).
 *
 * The item is re-read on `tx` because these three functions are handed a pull
 * request, not a card, and the raise needs the row's workspace, project and routing
 * target. Missing means the card is not visible to this transaction, which is the
 * same end state as nothing being owed.
 */
async function reraiseAfterWithdrawal(
  workItemId: string,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<void> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (item) await reconcileGatesFor(item, tx, signals);
}

/**
 * Is the card's awaiting ACCEPTANCE question no longer owed? Each withdrawer below then
 * supersedes it with its own cause —
 * the story-run half of the MOTIR-5903 amendment (`approval-gates.md` §1, point 1).
 *
 * On a story run the acceptance video is EVIDENCE for the one approve-to-merge decision,
 * so it is asked exactly while the set is green. Every event that withdraws the merge
 * question for a set that stopped being mergeable — a head move, a close, a draft, a set
 * change — therefore withdraws it too, with the same cause. Asked through the predicate
 * rather than decided here, so a question that IS still owed (a subtask-run story whose
 * subtree is settled, or a set still green after an event about a different member) is
 * left exactly where it is.
 */
async function acceptanceNoLongerOwed(
  workItemId: string,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<boolean> {
  const awaiting = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).some(
    (row) => row.kind === ACCEPTANCE_KIND,
  );
  if (!awaiting) return false;
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item) return false;
  const set = await gateSetFor(item, tx, signals);
  return !set.awaited.some((gate) => gate.kind === ACCEPTANCE_KIND);
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
    const signals: GateSetSignals = { movedHead: { pullRequestId, headSha } };
    const gate = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).find(
      (row) => row.kind === KIND,
    );
    if (!gate) {
      // No merge question to retire — but a story run's acceptance question may be
      // awaiting on its own (an `auto` project raises no merge gate), and a moved head
      // makes the set it is evidence for not green (MOTIR-5903).
      if (await acceptanceNoLongerOwed(workItemId, tx, signals)) {
        await approvalGateRepository.supersedeAwaitingByWorkItem(
          workItemId,
          ACCEPTANCE_KIND,
          'head_moved',
          tx,
        );
        await reraiseAfterWithdrawal(workItemId, tx, signals);
      }
      continue;
    }
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
    // Named, so a gate raised and withdrawn again in the same minute can be traced to
    // the head each side read (MOTIR-5604).
    console.warn('[pullRequestApprovalGates] withdrawn on a head move', {
      workItemId,
      pullRequestId,
      asked: gate.subjectVersion,
      current,
    });
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'head_moved',
      tx,
    );
    // The acceptance question rides on the same green set (MOTIR-5903).
    if (await acceptanceNoLongerOwed(workItemId, tx, signals)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'head_moved',
        tx,
      );
    }
    // ⚠️ AND ASK WHAT THE CARD SHOULD HOLD NOW (MOTIR-5663). The commits just
    // changed, so the new head has no verdict yet and the predicate answers *no
    // merge gate* — the NEXT green raises it. That is the case worth stating,
    // because it is the one that makes this call look pointless: it is not the
    // re-raise that matters here, it is that the re-ask happens at all. A design
    // gate the card is owed and does not have goes up from the same statement.
    await reraiseAfterWithdrawal(workItemId, tx, signals);
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
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'member_closed',
      tx,
    );
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'member_closed',
        tx,
      );
    }
    await reraiseAfterWithdrawal(workItemId, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on a DRAFT: a member was converted back to a draft (MOTIR-5699), so its author
 * has taken the set out of review and the host will not merge it. Every card the pull
 * request delivers loses its awaiting gate, and the re-ask raises no merge gate while the
 * member stays a draft — `mergeCandidateHead` refuses one. Marking it ready again is what
 * re-asks (`changeRequestStatusSync`'s ready-flip). A gate already decided is untouched.
 */
export async function withdrawPullRequestApprovalGatesOnDraft(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'member_drafted',
      tx,
    );
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'member_drafted',
        tx,
      );
    }
    await reraiseAfterWithdrawal(workItemId, tx);
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
  const withdrawn = await approvalGateRepository.supersedeAwaitingByWorkItem(
    workItemId,
    KIND,
    'set_changed',
    tx,
  );
  if (await acceptanceNoLongerOwed(workItemId, tx)) {
    await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      ACCEPTANCE_KIND,
      'set_changed',
      tx,
    );
  }
  await reraiseAfterWithdrawal(workItemId, tx);
  return withdrawn;
}
