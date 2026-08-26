import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `buildPlanRowViews` is a SERVER module (see `planRowView.test.ts` for why the
// formatter alone is stubbed). Everything else here is real — real Postgres, the
// real services, the real repositories.
vi.mock('next-intl/server', () => ({
  getFormatter: async () => ({ relativeTime: (d: Date) => `at ${d.toISOString()}` }),
}));

import { db } from '@/lib/db';
import { PLAN_STATUS_DTO_VALUES, type PlanStatusDto } from '@/lib/dto/plans';
import { planStatusFromParam } from '@/lib/planning/planStatusFilter';
import { plansService } from '@/lib/services/plansService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { planStatusSchema } from '@/lib/api/v1/workLoop/schema';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

const { buildPlanRowViews } = await import('@/app/(authed)/plans/planRowView');

// THE FIFTH `PlanStatus` MEMBER (Bug MOTIR-3560 · Subtask MOTIR-3578), decided by
// `docs/decisions/agent-authored-plans.md` AMENDMENT 9 (MOTIR-3574).
//
// ⚠️ WHY THIS FILE EXISTS AT ALL, given `PlanStatus` is a CLOSED Prisma enum.
// A closed enum sounds like it guarantees exhaustiveness and does — for switches
// written exhaustively. Most of the surfaces that render a plan status are not:
// two icon/tone maps are `Record`s (the compiler DOES catch those), `whenFor` has
// a `default:` arm, `StatusPill` ended in an unguarded fallthrough, and two
// components compute *is this decided?* by naming two statuses. The last three
// compile unchanged with a fifth value in the world and render the WRONG thing,
// which is why AMENDMENT 9 D6 enumerates them and why they are asserted here
// rather than trusted to `tsc`.
//
// ⚠️ AND NOTHING IN THIS CARD WRITES THE STATUS. No service transitions into it
// — that is MOTIR-3579 — so every case below reaches it by a DIRECT write
// through `adminDb`, which is also the only way to reach it in the product
// today. The last describe block asserts that absence rather than assuming it.

/** The only way into `stale` until MOTIR-3579 ships a transition: write it. */
async function forceStale(planId: string): Promise<void> {
  await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
}

async function plannedPlan(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Drifted' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A proposal', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the vocabulary — one edit, and every derived surface follows', () => {
  it('sits between `planned` and `approved` in the wire array, which is lifecycle order', () => {
    // The ORDER is load-bearing, not cosmetic: the tab strip iterates this array
    // and renders in that order, and `stale` is a DETOUR off `planned` — the only
    // status it is reachable from — rather than an ending, so it belongs before
    // the two terminal members (Part XI §4).
    expect([...PLAN_STATUS_DTO_VALUES]).toEqual([
      'generating',
      'planned',
      'stale',
      'approved',
      'declined',
    ]);
  });

  it('the v1 public schema accepts it, and still refuses a value that is not a member', () => {
    expect(planStatusSchema.parse('stale')).toBe('stale');
    expect(planStatusSchema.safeParse('outdated').success).toBe(false);
  });

  it('the URL parser accepts it, and the DEFAULT tab is still `planned`', () => {
    expect(planStatusFromParam('stale')).toBe('stale');
    // The two properties that must NOT move: an absent parameter and an unknown
    // one both resolve to `planned`, so every existing `/plans` link is unchanged.
    expect(planStatusFromParam(null)).toBe('planned');
    expect(planStatusFromParam('nonsense')).toBe('planned');
  });

  it('`countPlansByStatus` ZERO-FILLS it — derived from the array, not restated', async () => {
    const fx = await makeWorkItemFixture();
    await plansService.createPlan(fx.projectId, { title: 'Only one' }, fx.ctx);

    const counts = await plansService.countPlansByStatus(fx.projectId, fx.ctx);

    // Every member present, the new one at 0 — which is what lets the tab render
    // `Stale 0` rather than a blank chip (Part XI §4).
    expect(Object.keys(counts).sort()).toEqual([...PLAN_STATUS_DTO_VALUES].sort());
    expect(counts.stale).toBe(0);
  });

  it('counts a plan that IS in the status', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await forceStale(planId);

    expect((await plansService.countPlansByStatus(fx.projectId, fx.ctx)).stale).toBe(1);
  });
});

describe('the row view-model — the two sites the compiler cannot find', () => {
  it('reads `plannedAt` with the PLANNED verb — a named arm, not the `default:`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await forceStale(planId);
    const [plan] = (await plansService.listPlans(fx.projectId, fx.ctx, { status: 'stale' })).plans;

    const [view] = await buildPlanRowViews([plan!], fx.ctx);

    // ⚠️ THE ASSERTION IS ON THE KEY, and that is the point. `whenFor`'s
    // `default:` arm answers `createdAt`, which is right for `generating` and
    // silently wrong here — and is NOT a type error. A row falling through would
    // render *created 3 days ago* on a plan whose own moment is its close.
    expect(view!.whenKey).toBe('plannedAt');
    expect(view!.whenLabel).toBe(`at ${plan!.plannedAt!}`);
  });

  it('still counts ADVISORY drift on it — `staleCountFor` agrees with the service', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await forceStale(planId);
    const [plan] = (await plansService.listPlans(fx.projectId, fx.ctx, { status: 'stale' })).plans;

    // The engine is asked, rather than short-circuited to 0 — which is the whole
    // of AMENDMENT 9 D3's widening. A spy is the assertion because the COUNT for
    // an undrifted plan is 0 either way: the regression is the call not happening.
    const engine = vi.spyOn(planStalenessService, 'computePlanStaleness');
    await buildPlanRowViews([plan!], fx.ctx);
    expect(engine).toHaveBeenCalledTimes(1);
    engine.mockRestore();
  });

  it('a DECIDED plan still short-circuits — the widening did not become "always ask"', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    const [plan] = (await plansService.listPlans(fx.projectId, fx.ctx, { status: 'declined' }))
      .plans;

    const engine = vi.spyOn(planStalenessService, 'computePlanStaleness');
    const [view] = await buildPlanRowViews([plan!], fx.ctx);
    expect(engine).not.toHaveBeenCalled();
    expect(view!.staleCount).toBe(0);
    engine.mockRestore();
  });
});

describe('the staleness engine — AMENDMENT 9 D3, the clause this card is closed against', () => {
  it('ANSWERS for a `stale` plan instead of returning all-clear', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await forceStale(planId);

    const verdict = await planStalenessService.computePlanStaleness(planId, fx.ctx);

    // ⚠️ THIS IS THE BUG THE AMENDMENT CAUGHT BEFORE IT SHIPPED. MOTIR-3165's
    // guard read `status !== 'planned'`, so a plan ENTERING the new status would
    // have stopped producing per-proposal reasons — losing the reviewer the one
    // thing they need, *which proposal went stale*, at the exact moment they need
    // it. The verdict is computed for real here; the plan is undrifted, so every
    // item is clean, and the property is that the engine RAN.
    expect(verdict.planId).toBe(planId);
    expect(verdict.items).toHaveLength(1);
    expect(verdict.items[0]!.reasons).toEqual([]);
  });

  it('still returns all-clear for a DECIDED plan — MOTIR-3165 preserved, not overturned', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });

    const verdict = await planStalenessService.computePlanStaleness(planId, fx.ctx);

    // On a decided plan *would approving this now still be correct?* has no
    // meaning — that reasoning is unchanged. What the widening fixed is that its
    // PREDICATE had stopped matching it.
    expect(verdict.stale).toBe(false);
    expect(verdict.items.every((i) => !i.stale)).toBe(true);
  });
});

describe('NOTHING here writes the status — the lifecycle is otherwise unchanged', () => {
  it('`markPlanned` still lands on `planned`, never the new member', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    expect((await adminDb.plan.findUnique({ where: { id: planId } }))!.status).toBe('planned');
  });

  it('`approvePlan` still REFUSES a plan that is not `planned`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await forceStale(planId);

    // The guard is untouched by this card. Widening it — and `declinePlan`'s —
    // is MOTIR-3579's, arriving with the transition that can produce the status
    // in the first place; until then a `stale` plan is unreachable in the product.
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toThrow();
    expect((await adminDb.plan.findUnique({ where: { id: planId } }))!.status).toBe('stale');
  });

  it('no plan reaches the status through any service door', async () => {
    const fx = await makeWorkItemFixture();
    // Every write path the authoring surface exposes, run end to end.
    const plan = await plansService.createPlan(fx.projectId, { title: 'Ordinary' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A card', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);

    const rows = await adminDb.plan.findMany({ where: { projectId: fx.projectId } });
    const statuses = rows.map((r) => r.status as PlanStatusDto);
    expect(statuses).not.toContain('stale');
  });
});
