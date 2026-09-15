import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { routingTargetId } from '@/lib/approvalGates/routing';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { workItemsService } from '@/lib/services/workItemsService';

// THE `pull_request_approval` HANDLER — the registry's THIRD member (Story MOTIR-4909 ·
// MOTIR-5481; ADR docs/decisions/approval-gates.md §8's amendment, decisions 2 and 6).
//
// ONE question over the card's pull requests TOGETHER: *are these commits right?* Its
// subject is the run target's DELIVERY SET, so `subjectId` is the work item's own id and
// §6b's partial unique index over `(work_item_id, kind, subject_id)` in `awaiting` holds
// ONE awaiting approve-and-merge gate per card with no index of its own.
//
// ⚠️ LIKE THE MERGE HANDLER, IT DOES NOTHING OUTSIDE THE DATABASE. Approving writes
// `approved` in the door's transaction and stops there; each pull request is merged or
// enqueued AFTER that commit by MOTIR-5483's press, through MOTIR-4882's entry point
// (decision 5). This file never names a Git host.

/** The status an approval moves the card to — ADR §6b's `approved`, between In Review
 *  and Done. An INTENT the door resolves per project; see {@link approve} for why the
 *  resolved key is checked before it is written. */
export const PULL_REQUEST_APPROVAL_TARGET = { key: 'approved', category: 'in_progress' } as const;

/** What the gate is about: every delivery row the run target carries, with each pull
 *  request's check rows (its head) and repository. */
export type PullRequestApprovalSubject = WorkItemDeliveryWithChecks[];

// The set version lives in `deliverySetVersion.ts`, which imports no service, because the
// raise and the head-move withdrawal compute it inside the CI promotion too (MOTIR-5482).
export { deliverySetVersion };

export const pullRequestApprovalGateHandler: GateHandler<PullRequestApprovalSubject> = {
  /**
   * The subject is the card's delivery SET, read in the door's transaction. Null when
   * the card delivers nothing — the gate asks about pull requests, and there are none.
   *
   * `github_pull_request` stores no head sha of its own: a member's head is its latest
   * check run's commit, which is exactly the window the all-green verdict (and so the
   * gate) was formed over. `deliveryMemberVersion` reads it the merge handler's way.
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<PullRequestApprovalSubject | null> {
    const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(
      gate.subjectId,
      tx,
    );
    return deliveries.length > 0 ? deliveries : null;
  },

  /** WHICH commits were approved — the set's canonical string (decision 2). */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const deliveries = await this.resolveSubject(args);
    return deliveries
      ? deliverySetVersion(deliveries.map((delivery) => deliveryMemberVersion(delivery)))
      : null;
  },

  /** ADR §2: `assigneeId ?? reporterId` — the routing rule every kind shares. */
  routeTo({ item }: GateRoutingArgs): string | null {
    return routingTargetId(item);
  },

  /**
   * The FLOOR — `work_item:edit`, the design gate's. Pressing it records a decision and
   * moves the card; the MERGE a press then performs asserts its own floor
   * (`work_item:merge_pull_request`) on each merge gate. Who may press on top of the
   * floor is the door's §2 rule, `resolveGateAuthority` (decision 6).
   */
  permission: 'work_item:edit',

  statusIntent: PULL_REQUEST_APPROVAL_TARGET,

  /**
   * APPROVE — record the decision (the door does that) and move the card to `approved`.
   *
   * ⚠️ THE RESOLVED KEY IS CHECKED, NOT TRUSTED. The door resolves the intent through
   * `workflowsService.resolveStatusKey`, which prefers the key and falls back to the
   * CATEGORY — and `approved` shares `in_progress` with In Progress, Implemented and In
   * Review. On a workflow with no `approved` status that fallback answers some OTHER
   * in-progress status, and writing it would move an approved card sideways or back to
   * In Progress, reading as though nobody had looked. So anything but `approved` writes
   * no status and says why; the decision is still recorded.
   *
   * The transition goes through `workItemsService.applyStatusTransition` in the door's
   * transaction — the one status funnel — never a raw column write.
   */
  async approve({ gate, ctx, tx, resolvedStatusKey }: GateEffectArgs): Promise<GateEffect> {
    if (resolvedStatusKey !== PULL_REQUEST_APPROVAL_TARGET.key) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }
    await workItemsService.applyStatusTransition(gate.workItemId, resolvedStatusKey, ctx, tx);
    return { statusWritten: resolvedStatusKey };
  },

  /** REQUEST CHANGES — record the decision and move nothing. */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
