import type { DesignEvidence } from '@/generated/prisma/client';
import type { GateEffect, GateEffectArgs, GateHandler } from '@/lib/approvalGates/registry';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemsService } from '@/lib/services/workItemsService';

// THE `design_result` HANDLER — the registry's first and, in this build, only
// member (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md §3 and its MOTIR-4911 amendment).
//
// It supplies the five things ADR §1's table asks of a kind — resolve the
// subject, route it, name its permission floor, and say what each verb DOES —
// and nothing else. Everything generic about deciding a gate (the lock, the
// re-read, the actor gate, the state refusals, the write of the decision itself)
// belongs to `approvalGatesService.decide` and is shared by every kind that will
// ever register.

/**
 * The status INTENT an approval resolves against. Never a hard-coded key: a
 * project may have renamed its statuses, so the resolver prefers the key and
 * falls back to the CATEGORY (`workflowsService.resolveStatusKey`). This is the
 * same intent shape `changeRequestStatusSync`'s `LIFECYCLE_TARGET` uses for a
 * merged pull request, deliberately — both are asking for "this project's done".
 */
export const DESIGN_APPROVAL_TARGET = { key: 'done', category: 'done' } as const;

export const designResultGateHandler: GateHandler<DesignEvidence> = {
  /**
   * The subject is the `DesignEvidence` row the gate was created for — the exact
   * VERSION that was published, not "the card's current design".
   *
   * ⚠️ Read by ID, never by `findCurrentByWorkItem`. A gate asks about the bytes
   * somebody is looking at, and a republish makes a different row current: a
   * current-row read would silently re-point an in-flight question at a version
   * the reviewer never saw. ADR §6a is explicit that *"approved the design"* is
   * not evidence and *"approved THESE bytes"* is.
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<DesignEvidence | null> {
    return designEvidenceRepository.findById(gate.subjectId, tx);
  },

  /** ADR §2: `assigneeId ?? reporterId` — exactly ONE recipient, assignee first. */
  routeTo({ item }: GateEffectArgs): string | null {
    return item.assigneeId ?? item.reporterId ?? null;
  },

  /**
   * The FLOOR. ADR §2's amendment retired the role-derived answer to *who may
   * press* in favour of the relationship rule the door applies — and kept
   * `work_item:edit` as the permission the design gate still sits on, *"applied
   * on top of it, not instead of it"*.
   */
  permission: 'work_item:edit',

  /**
   * ADR §1's table: the design gate owns **the move into the project's `done`
   * category**. An INTENT, never a key — a project may have renamed its
   * statuses, and the door's resolver prefers the key then falls back to the
   * category. The same intent shape `changeRequestStatusSync`'s
   * `LIFECYCLE_TARGET` uses for a merged pull request, deliberately: both are
   * asking for "this project's done".
   */
  statusIntent: DESIGN_APPROVAL_TARGET,

  /**
   * APPROVE — record the decision (the door does that), then move the card.
   *
   * ⚠️ THE DISCRIMINATOR (ADR §8). Approval is a TRIGGER, not a status write, and
   * what it triggers is decided by ONE question asked once, at decision time,
   * from data the product already has: **does this work item have a linked OPEN
   * pull request?** It is READ from the delivery rows — never a setting, never a
   * field on the card — which is the same set `countOtherOpenByWorkItem` already
   * gates the `deferred_open_pr` defer on.
   *
   * | the work item has …             | what approval does                          |
   * | ------------------------------- | ------------------------------------------- |
   * | **no linked OPEN pull request** | write `done`. Approval is TERMINAL          |
   * | **a linked OPEN pull request**  | write NO status — the merge writes `done`   |
   *
   * **The invariant both arms preserve: `done` has exactly ONE writer.** In the
   * first arm nothing will ever merge, so nothing else would write it. In the
   * second the merge webhook writes it, exactly as when a person merges by hand.
   * *"Approved but still `in_review`"* is what a second writer looks like from
   * the board, and it is the collision §8 exists to end.
   *
   * ⚠️ WHY THE SECOND ARM WRITES NOTHING RATHER THAN `approved`, ON THE RECORD.
   * ADR §8's Workflow B lands such a card in the `approved` WORK-ITEM status —
   * and that status does not exist. §6b's amendment says so in its own words:
   * *"This record does not decide the status's MIGRATION — its transitions, its
   * position, and the `restricted`-policy edges it needs are a sibling story's."*
   * That sibling is **MOTIR-4905**, which is `todo`. Verified rather than
   * assumed: `lib/workflows/defaultWorkflow.ts` carries eight statuses and no
   * `approved`, and the live tenant's own project workflow carries the same
   * eight. Writing it here would resolve to `UnknownStatusError` at runtime on
   * every request that reached this arm.
   *
   * So this arm writes no status, which is CORRECT today and not merely
   * expedient: the merge is what moves the card, and that is true with or
   * without an intermediate status to pause in. When MOTIR-4905 ships
   * `approved`, this arm gains one `applyStatusTransition` call and the
   * invariant above is untouched — `done` still has one writer.
   *
   * ⚠️ AND THIS ARM IS NOT THE ORDINARY PATH FOR THIS KIND. ADR §1's amendment
   * keys `design_result` to *"a design with **no pull request**"*; a design that
   * DID open one is Workflow B and takes a `pull_request_approval` gate, which
   * this build leaves as a registry hole. The arm exists because the gate is
   * created when the subject is PUBLISHED and the question is asked at DECISION
   * time — a pull request can appear in between — so a door that assumed its own
   * kind's precondition still held would write `done` over work that had not
   * merged.
   *
   * The transition goes through `workItemsService.applyStatusTransition` — the
   * one shipped status funnel — in the DOOR's transaction, never a raw
   * `work_item.status` write. That is what inherits the row lock, the tenant
   * gate, the project-access gate, the legal-edge validation, the revision row
   * and the `completedAt` stamp; a gate that wrote the column directly would be a
   * second status writer, and the two would eventually disagree about one row in
   * a way that is very hard to trace.
   */
  async approve({ gate, ctx, tx, resolvedStatusKey }: GateEffectArgs): Promise<GateEffect> {
    const openPullRequests = await workItemDeliveryRepository.countOpenByWorkItem(
      gate.workItemId,
      tx,
    );
    if (openPullRequests > 0) {
      return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
    }

    // A custom workflow with nothing in the `done` category. The resolver's own
    // contract calls null *"a legitimate answer the callers turn into a logged
    // no-op, never a crash"* — the decision is still recorded, which is the
    // audit artefact and the thing the reviewer pressed for.
    if (resolvedStatusKey === null) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }

    await workItemsService.applyStatusTransition(gate.workItemId, resolvedStatusKey, ctx, tx);
    return { statusWritten: resolvedStatusKey };
  },

  /**
   * REQUEST CHANGES — record the decision and move nothing (ADR §3).
   *
   * **It re-dispatches nothing.** The revise loop — the agent republishing after
   * a rejection — is Story 9.2's (MOTIR-693), and §5 draws that line
   * deliberately: this record owns the DECISION, 9.2 owns the ephemeral preview
   * and the re-dispatch.
   *
   * Its version supersedes and is reclaimed normally: only an APPROVAL pins its
   * bytes (§6c), and that pin is MOTIR-4913's, `blocked_by` this card.
   */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
