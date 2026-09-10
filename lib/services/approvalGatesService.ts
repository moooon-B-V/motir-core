import type { ApprovalGateState } from '@/generated/prisma/client';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { GateEffect } from '@/lib/approvalGates/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { handlerFor } from '@/lib/approvalGates/registry';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { toApprovalGateDto } from '@/lib/mappers/approvalGateMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE DECIDE DOOR (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md).
//
// ⚠️ ONE service and ONE route record a decision on ANY gate, for every kind that
// will ever exist — and the story's "one approve language" claim rests on that
// being true AT THE SERVICE LAYER, not merely on screen. If the two gates got two
// service doors, Motir would have two approval features that look alike, and
// every later change would have to be made twice and kept in agreement by nobody.
//
// So everything generic lives here — the lock, the re-read, the actor gate, the
// state refusals, the write of the decision — and everything kind-specific is a
// `GateHandler` in `lib/approvalGates/registry.ts`. A third kind is a row in the
// enum, a handler, and a renderer. No second vocabulary, no second control, no
// second decide door.

/** The two verbs. A kind may later carry a verb SET (ADR §1's amendment,
 *  `decision_choice`), which is why the door takes a decision rather than
 *  exposing `approve()` / `requestChanges()` as separate methods. */
export type GateDecision = 'approve' | 'request_changes';

const DECISION_STATE: Record<
  GateDecision,
  Extract<ApprovalGateState, 'approved' | 'changes_requested'>
> = {
  approve: 'approved',
  request_changes: 'changes_requested',
};

export interface DecideGateInput {
  gateId: string;
  decision: GateDecision;
  /** Why they said yes, or what they sent back. Free text, optional. */
  noteMd?: string | null;
}

export interface DecideGateResult {
  gate: ApprovalGateDTO;
  /** What the decision DID — the status it wrote, or why it wrote none. */
  effect: GateEffect;
}

export const approvalGatesService = {
  /**
   * DECIDE one gate. **The only way a gate's state ever changes.**
   *
   * The sequence, inside ONE `withWorkspaceContext` transaction, in this order —
   * and the order is the contract, not an implementation detail:
   *
   *   1. **Lock the gate row and RE-READ it.** Deciding is a read-derived write:
   *      the decision depends on the state it just read, so a plain
   *      read-then-write races two reviewers pressing in the same moment. The
   *      loser WAITS on the winner's commit (no `SKIP LOCKED` — there is no
   *      next-best gate to fall to) and then reads what actually happened, which
   *      is what lets the refusal NAME the winner.
   *   2. **Gate on the ACTOR** — the permission floor the kind names, then ADR
   *      §2's relationship rule. A reader who may browse but not decide gets a
   *      typed refusal, never a 404 and never a silent no-op.
   *   3. **Refuse a gate that is not `awaiting`**, naming who decided it and when,
   *      so the surface can say so in place rather than as a toast that scrolls
   *      away.
   *   4. **Write the decision** — `state`, `decidedById`, `decidedAt`, `noteMd`.
   *   5. **Run the kind's EFFECT**, dispatched through the registry.
   *
   * ⚠️ **NOTHING EXTERNAL HAPPENS INSIDE THE TRANSACTION.** There are no emails
   * and no webhooks in this card; the rule is stated and the seam is built so
   * the MERGE card — which does have an external call — inherits a boundary that
   * already exists rather than inventing one. A handler's `approve` performs
   * database work only; anything that leaves the process belongs after the
   * commit, in the door's caller.
   *
   * ⚠️ **WHAT IS DELIBERATELY NOT HERE.** Pinning an approved version's bytes
   * (ADR §6c), the supersede predicate, and the product-written `superseded`
   * transition (§6b) are **MOTIR-4913's**, `blocked_by` this card — the epic-wide
   * re-plan split this card at exactly that seam because the two together
   * re-crossed the estimation gate. This door REFUSES a `superseded` gate today;
   * nothing writes that state yet.
   */
  async decide(input: DecideGateInput, ctx: ServiceContext): Promise<DecideGateResult> {
    // ── BEFORE THE TRANSACTION ────────────────────────────────────────────────
    // Two reads that must NOT hold the gate's row lock:
    //
    //   · the gate's EXISTENCE and its kind, so the handler — and therefore the
    //     status INTENT — is known before anything is locked. This read is for
    //     existence and routing ONLY; every field the decision turns on is
    //     re-derived under the lock below, never carried over from here (the
    //     same discipline `acceptanceEvidenceService.decide` records);
    //   · the project's concrete key for that intent, which
    //     `workflowsService.resolveStatusKey` answers by opening its OWN
    //     transaction. Called from inside ours it would take a second pooled
    //     connection while we hold a `FOR UPDATE` lock — the deadlock shape
    //     `workItemsService` warns about at `applyStatusTransition`. It is a
    //     project's status VOCABULARY, i.e. reference data, so reading it early
    //     is both cheaper and correct.
    const preread = await withWorkspaceContext(ctx, async (tx) => {
      const gate = await approvalGateRepository.findById(input.gateId, tx);
      if (!gate) return null;
      const item = await workItemRepository.findById(gate.workItemId, tx);
      return item ? { gate, item } : null;
    });
    // Missing, or hidden by the workspace RLS policy. Indistinguishable on
    // purpose — a 404 that cannot confirm a foreign gate exists.
    if (!preread) throw new ApprovalGateNotFoundError(input.gateId);

    const handler = handlerFor(preread.gate.kind);
    const resolvedStatusKey = handler.statusIntent
      ? await workflowsService.resolveStatusKey(
          preread.item.projectId,
          ctx.workspaceId,
          handler.statusIntent,
        )
      : null;

    // ── THE TRANSACTION ───────────────────────────────────────────────────────
    return withWorkspaceContext(ctx, async (tx) => {
      // 1 · LOCK AND RE-READ. Everything below reads THIS row, not the pre-read.
      const locked = await approvalGateRepository.lockById(input.gateId, tx);
      if (!locked) throw new ApprovalGateNotFoundError(input.gateId);

      const item = await workItemRepository.findById(locked.workItemId, tx);
      // Tenant gate FIRST, exactly as `applyStatusTransition` does it: a
      // cross-workspace row is indistinguishable from a never-existed one, and
      // must not leak through a state or permission error.
      if (!item || item.workspaceId !== ctx.workspaceId) {
        throw new ApprovalGateNotFoundError(input.gateId);
      }

      // 2 · THE ACTOR GATE, in two halves that are NOT interchangeable.
      //
      // (a) THE FLOOR — the permission the KIND names. It raises
      //     `ProjectNotFoundError` (→ 404) for an actor who cannot BROWSE the
      //     project and `PermissionDeniedError` (→ 403) for one who can browse
      //     but lacks the key, which is exactly the no-existence-leak posture
      //     the card asks for: *an actor without the decide permission gets a
      //     typed refusal; an actor who cannot browse gets a not-found, so
      //     neither leaks the other.* `tx` is threaded so the gate shares this
      //     transaction's snapshot AND its bound workspace GUC.
      await projectAccessService.assertPermission(item.projectId, ctx, handler.permission, tx);

      // (b) THE RELATIONSHIP — ADR §2's amendment (Yue, 2026-09-08):
      //     **assignee OR reporter OR admin**, for both verbs, an admin on ANY
      //     work item. Authority follows a relationship to the item, not a
      //     permission a role happens to carry.
      //
      //     ⚠️ It is APPLIED ON TOP OF the floor, never instead of it. And it is
      //     NOT the routing rule: a gate is SHOWN to one person
      //     (`assigneeId ?? reporterId`) and may be PRESSED by three. The two
      //     axes answer different questions — routing answers *whose job is it
      //     to look?*, where a gate shown to two people is a decision neither
      //     owns; authority answers *may this press be honoured?*, where the
      //     failure to prevent is the opposite one, a single recipient on leave
      //     and nobody able to unblock the work.
      //     ⚠️ THE ADMIN ARM IS **ASKED**, NEVER DERIVED HERE. Reading this
      //     actor's own membership row and testing `isWorkspaceManager(...)` in
      //     this file is exactly the SECOND POLICY PATH the model forbids —
      //     `tests/permissions/storyGate.test.ts` guard 1 and
      //     `memberFacingGate.integration.test.ts` both refuse it by name,
      //     because such a rule is *"invisible in the grid, un-grantable to a
      //     custom role, and un-auditable by the guard."* So the question goes to
      //     `projectAccessService`, which owns the always-pass rail; this service
      //     composes the answer and derives nothing.
      const authorised =
        item.assigneeId === ctx.userId ||
        item.reporterId === ctx.userId ||
        (await projectAccessService.isWorkspaceManagerFor(item.projectId, ctx, tx));
      if (!authorised) throw new ApprovalGateNotAuthorisedError(input.gateId);

      // 3 · REFUSE A GATE THAT IS NOT `awaiting`.
      //
      // ⚠️ TWO refusals, not one, and the split mirrors ADR §6b's own: a DECIDED
      // gate is somebody's answer and a SUPERSEDED one is a withdrawn question.
      // Collapsing them would make the surface say "somebody already decided
      // this" about a question nobody answered — the one sentence the audit must
      // never be able to produce.
      if (locked.state === 'superseded') throw new ApprovalGateSupersededError(input.gateId);
      if (locked.state !== 'awaiting') {
        throw new ApprovalGateAlreadyDecidedError(
          input.gateId,
          locked.state,
          locked.decidedById,
          locked.decidedAt,
        );
      }

      // 4 · WRITE THE DECISION. Under the lock, before the effect — so a failing
      // effect rolls the decision back with it and a gate is never left decided
      // for a transition that did not happen.
      const decided = await approvalGateRepository.decide(
        locked.id,
        {
          state: DECISION_STATE[input.decision],
          decidedById: ctx.userId,
          decidedAt: new Date(),
          noteMd: input.noteMd?.trim() ? input.noteMd : null,
        },
        tx,
      );

      // 5 · THE KIND'S EFFECT, dispatched through the registry — in the SAME
      // transaction, which is what makes "approving unblocks the cards
      // `blocked_by` this one" true in the same request rather than eventually.
      const args = {
        gate: {
          id: locked.id,
          workspaceId: locked.workspaceId,
          projectId: locked.projectId,
          workItemId: locked.workItemId,
          subjectId: locked.subjectId,
        },
        item,
        ctx,
        tx,
        resolvedStatusKey,
      };
      const effect =
        input.decision === 'approve'
          ? await handler.approve(args)
          : await handler.requestChanges(args);

      return { gate: toApprovalGateDto(decided), effect };
    });
  },
};
