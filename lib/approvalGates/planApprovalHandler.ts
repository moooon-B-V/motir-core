import type { Plan, Prisma } from '@/generated/prisma/client';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateOutsideTransactionArgs,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import type { PlanGateHeldDTO } from '@/lib/dto/approvalGate';
import type { ApprovePlanPreparation } from '@/lib/services/plansService';
import {
  ApprovalGateStaleSubjectError,
  ApprovalGateVerbNotOfferedError,
} from '@/lib/approvalGates/errors';
import { planSubjectVersion } from '@/lib/approvalGates/planApprovalDigest';
import { revisionLeaseOf, type RevisionLeaseRow } from '@/lib/planChange/revisionLease';
import { PlanNotFoundError, PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';

// THE `plan_approval` HANDLER (Story MOTIR-6012 · Subtask MOTIR-6035; ADR
// `docs/decisions/approval-gates.md` §11.3–§11.6, §11.10).
//
// The FIRST kind whose gate belongs to NO work item: its `subjectId` IS the plan's id,
// and `args.item` is always null. So it NEVER calls `requireArgsCard` /
// `requireGateCard` — there is no card to narrow to, and a guessed one would decide
// somebody else's work.
//
// It is the ONLY place a plan's decision semantics live. The door stays kind-blind:
// it takes the plan's lock first because this handler says so
// (`lockSubjectBeforeGate`), stamps the live digest because this handler says so
// (`stampsLiveVersion`), and runs `approvePlan`'s pre- and post-transaction phases
// through the generic seams. `plansService.approvePlanWithin` / `declinePlanWithin`
// are the bodies `approvePlan` / `declinePlan` run — reused, never re-implemented, so
// materialize, the resting statuses, the revision-lease refusal and the trail row keep
// one home each.
//
// ⚠️ THE VERBS (§11.4). `approve` materializes the plan. `decline` — the NEW optional
// verb — ends it (`declined` / `reviewed`). `request_changes` is NOT OFFERED: a plan is
// changed by TALKING to the planner, which writes a new version of the SAME plan, so a
// verb that recorded a refusal and then waited would leave the question looking open
// for something only a conversation can cause.
//
// ⚠️ DECLINE'S NOTE IS OPTIONAL — A DELIBERATE DEPARTURE FROM §10a, stated here so a
// later reader does not "fix" it (§11.4, §11.10). §10a requires a reason on every
// refusal because a no is feedback somebody has to act on. A decline hands nothing to
// anybody: no run picks the plan up, no planner opens, and the gate is routed to the
// person who asked for the plan, so ordinarily the decider is declining their own
// request. They CAN give a reason — the door stores `noteMd` when given.
//
// ⚠️ HELD IS DERIVED, NEVER STORED (§11.5c). The plan stays `planned` through a
// revision, so "held" is the REVISION LEASE, and the refusal is inherited: both
// `…Within` bodies call `assertNoRevisionInFlight` under the plan lock and throw
// `PlanRevisionInFlightError`, and the door's transaction rolls back with the gate
// still `awaiting`. When the lease ends the SAME gate is decidable against the new
// digest — a reader holding a stamp from before the revision is refused stale.

/** A plan gate's in-transaction deciding, with the door's own lock already held. */
async function lazyPlansService() {
  // ⚠️ IMPORTED HERE, NOT AT THE TOP — `plansService` reaches the work-item services,
  // which reach `approvalGatesService` → registry → this handler: the same cycle
  // `decisionConfirmationHandler` breaks the same way.
  return (await import('@/lib/services/plansService')).plansService;
}

/** The plan a gate asks about, in the gate's own workspace, or null when it is gone. */
async function planOf(gate: GateEffectArgs['gate'], tx: Prisma.TransactionClient) {
  return planRepository.findById(gate.subjectId, gate.workspaceId, tx);
}

/**
 * The subject a FRESH plan gate would ask about right now — the plan's id while it is
 * `planned`, else null (§11.7: a decided, stale or generating plan asks nothing).
 * Exported for MOTIR-6036's raise, which knows the plan id the routing args lack.
 */
export async function currentPlanSubject(
  planId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const plan = await planRepository.findById(planId, workspaceId, tx);
  return plan?.status === 'planned' ? plan.id : null;
}

/**
 * WHO a plan gate is ROUTED to (§11.6) — the person who asked for the plan
 * (`Plan.createdById`), or, on a `cadence` plan where nobody asked, the workspace
 * OWNER (the identity the cadence watcher already acts as). A workspace with no owner
 * row routes to nobody, and the gate is still decidable from the planning surface.
 *
 * ⚠️ ASYNC AND EXPORTED, because `GateHandler.routeTo` is synchronous and is handed
 * `{ item: null, ctx, tx }` for this kind — it has neither the plan nor a way to read
 * it. MOTIR-6036's raise calls this to write `routedToId` in the raising transaction.
 */
export async function resolvePlanGateRoute(
  plan: Pick<Plan, 'createdById' | 'workspaceId'>,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (plan.createdById) return plan.createdById;
  const owner = await workspaceMembershipRepository.findOwnerByWorkspace(plan.workspaceId, tx);
  return owner?.userId ?? null;
}

/** A plan's trail → the gate's `held`, or null when no revision holds it (§11.5c). */
export function planGateHeldOf(
  trail: readonly RevisionLeaseRow[],
  now: Date = new Date(),
): PlanGateHeldDTO | null {
  const lease = revisionLeaseOf(trail, now);
  return lease
    ? {
        reason: 'revision_in_flight',
        heldBy: lease.heldBy,
        expiresAt: lease.expiresAt.toISOString(),
      }
    : null;
}

/** One plan's `held`, read in the caller's transaction. */
export async function readPlanGateHeld(
  planId: string,
  tx: Prisma.TransactionClient,
): Promise<PlanGateHeldDTO | null> {
  return planGateHeldOf(await planRevisionRepository.listByPlan(planId, tx));
}

/** Refuse anything but a `planned` plan, whatever the digest says (§11.3). */
function assertPlanned(plan: Plan): void {
  if (plan.status !== 'planned') {
    throw new PlanNotInExpectedStatusError(plan.id, plan.status, 'planned');
  }
}

/** The onboarding rename's placeholder, when the entrance passed one through the door
 *  (MOTIR-6038 — `planDecisionService.approve`'s `provisionalProjectName`). */
function provisionalProjectNameOf(args: GateEffectArgs): string | null {
  const name = args.effectOptions?.provisionalProjectName;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** What approve and decline report to the door — a plan's status moved, no card's. */
function planDecisionEffect(afterCommit: () => Promise<void>): GateEffect {
  return {
    statusWritten: null,
    statusDeferredReason: 'plan_decision_writes_no_work_item',
    afterCommit,
  };
}

export const planApprovalGateHandler: GateHandler<Plan> = {
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<Plan | null> {
    return planOf(gate, tx);
  },

  // §11.3's digest — the ONE function the render read calls too. Null when the plan is
  // gone, which the door records as a weaker row rather than a refusal.
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const plan = await planOf(args.gate, args.tx);
    return plan ? planSubjectVersion(plan.id, args.tx) : null;
  },

  // A revision rewrites the SAME plan in place and never supersedes its gate
  // (§11.5c), so the stamp must read the digest as it is under the lock.
  stampsLiveVersion: true,

  // THE LOCK ORDER (§11.5): every plan-side writer holds the plan's lock when it
  // reaches the gate, so the door takes the plan's first.
  async lockSubjectBeforeGate(subjectId: string, tx: Prisma.TransactionClient): Promise<void> {
    await planRepository.lockById(subjectId, tx);
  },

  // ⚠️ NULL FOR A CARD-LESS GATE, deliberately — `routeTo` is synchronous and is given
  // no plan (`item` is null). The real answer is `resolvePlanGateRoute`, which the
  // raise (MOTIR-6036) awaits to write `routedToId`; every read of a card-less row
  // then routes by that column (MOTIR-6034).
  routeTo(_args: GateRoutingArgs): string | null {
    return null;
  },

  // The raise's generic loop (`raiseOnReviewEntry`) skips card-less kinds, so this is
  // asked only with a gate in hand (a decision-time caller passes `GateEffectArgs`).
  // Without one there is no plan to name.
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const gate = (args as Partial<GateEffectArgs>).gate;
    return gate ? currentPlanSubject(gate.subjectId, gate.workspaceId, args.tx) : null;
  },

  // §11.6: the kind's permission and nothing else — no work item, so §2's relationship
  // rule does not apply. The door records the decider's authority as `plan_permission`.
  permission: 'ai:decide_plan',

  // §11.5: the handler writes a PLAN's status, never a work item's.
  statusIntent: null,

  // Approve materializes a whole subtree inside the door's transaction.
  transactionBudget: { timeoutMs: 30_000, maxWaitMs: 10_000 },

  // APPROVE's pre-transaction phase — the reads that open their own context and the
  // best-effort repository-set proposal (`approvePlan`'s, unchanged). A plan that is
  // gone prepares nothing: the verb then answers the stale-subject refusal.
  async beforeTransaction({ subjectId, decision, ctx }: GateOutsideTransactionArgs) {
    if (decision !== 'approve') return undefined;
    try {
      return await (await lazyPlansService()).prepareApprovePlan(subjectId, ctx);
    } catch (err) {
      if (err instanceof PlanNotFoundError) return undefined;
      throw err;
    }
  },

  // The lazy `stale` backstop and the timeout's typed refusal — `approvePlan`'s
  // post-rollback handling, applied to the door's rolled-back transaction.
  async afterRollback(err: unknown, { decision, ctx, prepared }: GateOutsideTransactionArgs) {
    if (decision !== 'approve' || !prepared) return err;
    return (await lazyPlansService()).approveFailure(err, prepared as ApprovePlanPreparation, ctx);
  },

  /** APPROVE — materialize the plan exactly as `approvePlan` does (§11.4, §11.5). */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, ctx, tx } = args;
    const plan = await planOf(gate, tx);
    if (!plan || !args.prepared) throw new ApprovalGateStaleSubjectError(gate.id, ['subject']);
    assertPlanned(plan);
    const { afterCommit } = await (
      await lazyPlansService()
    ).approvePlanWithin(tx, plan.id, ctx, args.prepared as ApprovePlanPreparation, {
      provisionalProjectName: provisionalProjectNameOf(args),
    });
    return planDecisionEffect(afterCommit);
  },

  /** DECLINE — end the plan, `declined` / `reviewed`, as `declinePlan` does from
   *  `planned` (§11.4). The note is optional; see the header. */
  async decline(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, ctx, tx } = args;
    const plan = await planOf(gate, tx);
    if (!plan) throw new ApprovalGateStaleSubjectError(gate.id, ['subject']);
    assertPlanned(plan);
    const { afterCommit } = await (await lazyPlansService()).declinePlanWithin(tx, plan.id, ctx);
    return planDecisionEffect(afterCommit);
  },

  /**
   * NOT OFFERED (§11.4). The door refuses the verb before dispatching; this answers the
   * same refusal so a caller that reached the handler directly cannot record one.
   */
  async requestChanges({ gate }: GateEffectArgs): Promise<GateEffect> {
    throw new ApprovalGateVerbNotOfferedError(gate.id, 'request_changes_on_plan');
  },
};
