import type { ApprovalGate, Plan, Prisma } from '@/generated/prisma/client';
import { planSubjectVersion } from '@/lib/approvalGates/planApprovalDigest';
import { currentPlanSubject, resolvePlanGateRoute } from '@/lib/approvalGates/planApprovalHandler';
import {
  approvalGateRepository,
  type LiveSupersedeCause,
} from '@/lib/repositories/approvalGateRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';

// THE PLAN GATE'S LIFECYCLE — when a `plan_approval` gate is RAISED, and when it is
// WITHDRAWN (Story MOTIR-6012 · Subtask MOTIR-6036; ADR `approval-gates.md` §11.5,
// §11.5c, §11.7, §11.8).
//
// The one place a plan gate is asked or withdrawn. The plain status writers (§11.8)
// keep writing `Plan.status` themselves and call in here, INSIDE the transaction that
// writes the status, so a plan is never `planned` without its question and a plan that
// stops being a question never keeps one:
//
//   · RAISE — `plansService.markPlanned` (the close, ≥1 proposal) and
//     `planDriftService.restoreForRevivedTarget` (`stale → planned`, a FRESH gate:
//     the old one was superseded while nobody could approve it). MOTIR-6039's backfill
//     calls the same `raise`.
//   · SUPERSEDE `plan_stale` — `planDriftService.markStaleForTerminalTarget`, and
//     `approvePlan`'s lazy backstop (`markStaleOnImmutableTarget`).
//   · SUPERSEDE `plan_discarded` — `withdrawProposal`'s LAST-proposal discard.
//
// ⚠️ WHAT DOES NOT TOUCH THE GATE (§11.5c, §11.7), stated so nobody "completes" it:
//
//   · A REVISION (`revision: true` append on a `planned` plan). The plan stays
//     `planned` and the gate is HELD — derived from the revision lease by the handler
//     (`planGateHeldOf`), never written. Superseding would drop the row out of To
//     approve mid-conversation and re-raise it a moment later as a new question: two
//     rows in the record for one question.
//   · A CORRECTION outside a lease (`update_plan_proposal`, `withdraw_plan_proposal`
//     short of the last). It moves the digest and supersedes nothing — the door's
//     stamp refuses a reader who read the old version (§11.3).
//   · THE ABANDONED-PLAN SWEEP (`abandonedPlanService`). It selects and re-checks only
//     `generating` plans, which have no gate. If it ever widens to `planned` it owes a
//     supersede cause of its own under the enum's one-member-per-path rule.
//   · The EMPTY close. `markPlanned` over zero proposals writes `declined` /
//     `discarded`: there was never a question.
//
// ⚠️ THE LOCK ORDER — THE PLAN ROW, THEN THE GATE ROW (§11.5). The decide door takes
// the plan's lock before the gate's for this kind, so every writer here must too, or a
// busy project deadlocks. Both verbs TAKE the plan lock themselves before they touch a
// gate row: a caller that already holds it re-locks a row its own transaction holds,
// which Postgres treats as a no-op, and a caller that does not (the backfill) cannot
// get the order wrong.

const KIND = 'plan_approval' as const;

/** The two causes a plan-side writer withdraws a plan gate with (§11.7). */
export type PlanGateSupersedeCause = Extract<LiveSupersedeCause, 'plan_stale' | 'plan_discarded'>;

/** What {@link planGateService.raise} did. */
export interface PlanGateRaise {
  /** True when THIS call inserted the awaiting row. */
  raised: boolean;
  /** The plan's awaiting gate after the call — this call's, or the one it found —
   *  absent when the plan asks nothing (not `planned`, or no proposals). */
  gate?: ApprovalGate;
}

export const planGateService = {
  /**
   * RAISE the plan's `awaiting` gate, when the plan is a question right now: it is
   * `planned` and holds at least one proposal. Idempotent — a second call, or a
   * concurrent one, finds the first's row (the card-less partial unique index
   * resolves the race inside the statement, `ON CONFLICT DO NOTHING`).
   *
   * Routed per §11.6 (`resolvePlanGateRoute`), stamped with the digest it was raised
   * against. Reads the plan's status UNDER the plan lock, so a caller's stale copy
   * cannot raise a gate on a plan somebody decided meanwhile.
   */
  async raise(
    plan: Pick<Plan, 'id' | 'workspaceId' | 'projectId' | 'createdById'>,
    tx: Prisma.TransactionClient,
  ): Promise<PlanGateRaise> {
    await planRepository.lockById(plan.id, tx);
    const subjectId = await currentPlanSubject(plan.id, plan.workspaceId, tx);
    if (!subjectId) return { raised: false };
    if ((await planItemRepository.countByPlan(plan.id, tx)) === 0) return { raised: false };
    const raised = await approvalGateRepository.createCardlessAwaitingIfAbsent(
      {
        workspaceId: plan.workspaceId,
        projectId: plan.projectId,
        kind: KIND,
        subjectId,
        routedToId: await resolvePlanGateRoute(plan, tx),
        subjectVersion: await planSubjectVersion(plan.id, tx),
      },
      tx,
    );
    // Under the plan lock the row just raised — or the winner's — is the one awaiting.
    const [gate] = await approvalGateRepository.findAwaitingCardlessBySubject(KIND, subjectId, tx);
    return { raised, gate };
  },

  /**
   * WITHDRAW the plan's `awaiting` gate, saying why. `cause` is REQUIRED — the
   * repository's rule (a supersede that cannot say why reads as a false sentence on
   * every surface). Returns how many rows moved: 0 when nothing was awaiting (a plan
   * raised before this shipped, or already decided through the door).
   */
  async supersede(
    planId: string,
    cause: PlanGateSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    await planRepository.lockById(planId, tx);
    return approvalGateRepository.supersedeAwaitingCardlessBySubject(KIND, planId, cause, tx);
  },
};
