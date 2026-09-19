import type { Prisma, WorkItem } from '@/generated/prisma/client';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import {
  decisionIdentityOf,
  decisionSubjectVersion,
  type DecisionIdentity,
  type DecisionMember,
} from '@/lib/approvalGates/decisionSubject';
import { ApprovalGateDecisionUnresolvableError } from '@/lib/approvalGates/errors';
import { decisionApprovalStandsForMerge } from '@/lib/approvalGates/gateSet';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { routingTargetId } from '@/lib/approvalGates/routing';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';

// THE `decision_approval` HANDLER (Story MOTIR-4907 · Subtask MOTIR-5676; ADR
// `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT).
//
// ONE question: *is this decision right?* — asked of the ONE `docs/decisions/*.md`
// file a `decision` + `coding_agent` card's pull request carries. It is the design
// gate's arrangement with a document for its port: PRIMARY over the approve-to-merge
// gate, one press decides both, and the merge webhook stays the only writer of `done`.
//
// ⚠️ EVERY SEAM HERE READS THE DATABASE AND NOTHING ELSE. The door calls them inside
// its transaction, under the gate's lock, and a transaction may not wait on a Git
// host (clause 7). So the subject is the document's IDENTITY — path and blob sha,
// captured onto the pull request when its head was observed (MOTIR-5674) — and the
// CONTENT a person reads is fetched separately, outside any transaction, through the
// resolver (`decisionDocumentResolver.ts`, `decisionDocumentService.ts`).
//
// ⚠️ MOTIR STORES NO DOCUMENT. Nothing here writes one, and the gate row carries only
// an opaque `subjectId` (the card) and a version string (the blob) — so moving
// decision documents into a pages domain later is a resolver change, never a
// migration on the audit table.

/**
 * The card's OPEN delivering pull requests, as the subject reads them. A merged or
 * closed pull request asks nothing: its document either already shipped or never
 * will.
 */
export function decisionMembersOf(
  deliveries: readonly WorkItemDeliveryWithChecks[],
): DecisionMember[] {
  return deliveries
    .filter((delivery) => delivery.pullRequest.state === 'open' && !delivery.pullRequest.merged)
    .map((delivery) => ({
      repo: `${delivery.repo.owner}/${delivery.repo.name}`,
      number: delivery.pullRequest.number,
      outcome: delivery.pullRequest.decisionDocOutcome,
      path: delivery.pullRequest.decisionDocPath,
      blobSha: delivery.pullRequest.decisionDocBlobSha,
      headSha: delivery.pullRequest.decisionDocHeadSha,
      paths: delivery.pullRequest.decisionDocPaths,
    }));
}

/**
 * The decision identity of ONE card, read on the caller's transaction — the single
 * place the handler, the gate set (MOTIR-5677) and the document read load it from,
 * so they cannot disagree about what the card is being asked.
 */
export async function loadDecisionIdentity(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<DecisionIdentity | null> {
  return decisionIdentityOf(
    decisionMembersOf(await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx)),
  );
}

/**
 * DOES THE DECISION HOLD THIS CARD'S MERGE? (Story MOTIR-4907 · MOTIR-5677;
 * `approval-gates.md` §8's FIFTH AMENDMENT, clauses 5 and 6.)
 *
 * True for a `decision` + `coding_agent` card whose decision has NOT been approved over
 * the document its pull requests carry now — awaiting, sent back, unresolvable, never
 * captured, or approved over a document a later push rewrote. False for every other
 * card, which is what keeps a code card's and a design card's merges exactly as they
 * were.
 *
 * ⚠️ ONE ANSWER FOR EVERY DOOR THAT WOULD MERGE. `settleGreenVerdict`'s `auto` arm, the
 * approve-to-merge gate's own `approve` (the item page's merge row, the REST route) and
 * the GitHub review sync all ask it, so *the merge follows only the decision* is one
 * statement rather than three that could drift.
 */
export async function decisionHoldsMerge(
  item: Pick<WorkItem, 'id' | 'type' | 'executor'>,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  if (!asksTheDecisionQuestion(item)) return false;
  const [identity, latestDecisionGate] = await Promise.all([
    loadDecisionIdentity(item.id, tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'decision_approval', tx),
  ]);
  return !decisionApprovalStandsForMerge(identity, latestDecisionGate);
}

export const decisionApprovalGateHandler: GateHandler<DecisionIdentity> = {
  /**
   * The document's IDENTITY (clause 1) — which file, at which blob, in which pull
   * request — or null when no open pull request delivers the card or none has been
   * captured. `subjectId` is the card, so this reads the card's delivery set.
   *
   * An UNRESOLVABLE identity is still a subject (clause 3): the gate exists, says
   * why, and holds the merge. Only `approve` refuses it.
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<DecisionIdentity | null> {
    return loadDecisionIdentity(gate.subjectId, tx);
  },

  /** `owner/name:path@blobSha`, or the unresolvable form — clause 4. */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const identity = await this.resolveSubject(args);
    return identity ? decisionSubjectVersion(identity) : null;
  },

  /**
   * RE-ASK ON REVIEW ENTRY (ADR §6d AMENDMENT, rule 7): the card itself, when it asks
   * the decision question at all (clause 10) and a captured head gives it something to
   * ask about; otherwise null.
   *
   * ⚠️ A `human` decision card answers null ALWAYS — its choice is Story MOTIR-4914's
   * `decision_choice`, never this gate — and so does every card whose TYPE is not
   * `decision`, whatever files its pull request touches.
   */
  async currentSubject({ item, tx }: GateRoutingArgs): Promise<string | null> {
    if (!asksTheDecisionQuestion(item)) return null;
    return (await loadDecisionIdentity(item.id, tx)) ? item.id : null;
  },

  /** ADR §2: `assigneeId ?? reporterId` — the routing rule every kind shares. */
  routeTo({ item }: GateRoutingArgs): string | null {
    return routingTargetId(item);
  },

  /** The design gate's floor. Who may press on top of it is the door's §2 rule. */
  permission: 'work_item:edit',

  /**
   * NONE (clause 5). The decision press writes no status: `approved` is written by
   * the COMPANION approve-to-merge gate the same press decides, and `done` only by the
   * merge webhook. Owning a transition here would make a second writer of a status
   * the companion already owns.
   */
  statusIntent: null,

  /**
   * APPROVE — record the decision (the door does that) and move nothing, exactly as
   * `designResultGateHandler.approve` does while a pull request is open — and for this
   * kind one always is (clause 2). The merge that follows is carried by the press
   * (`pullRequestMergeService`) and, when the set is not green yet, by the next green
   * verdict (MOTIR-5677).
   *
   * ⚠️ REFUSED WHILE UNRESOLVABLE (clause 3), read UNDER THE DOOR'S LOCK from the
   * capture. A card whose pull requests carry no document, several, or one the host
   * could not name has nothing a person can have read and accepted.
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const identity = await this.resolveSubject(args);
    if (!identity) throw new ApprovalGateDecisionUnresolvableError('none');
    if (!identity.resolvable) throw new ApprovalGateDecisionUnresolvableError(identity.reason);
    return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
  },

  /**
   * REQUEST CHANGES — record the decision and move nothing. ALLOWED on an unresolvable
   * subject: *"there is no document here"* is exactly what it exists to say.
   */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
