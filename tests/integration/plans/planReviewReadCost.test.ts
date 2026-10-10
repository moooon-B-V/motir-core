import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planReviewService } from '@/lib/services/planReviewService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-8103 — the review read a `generating` plan's poll makes every 2.5 s.
//
// `getPlanReview` first reads the plan WITH its items and admits the reader
// (`getPlanForReader`), then asked `computePlanStaleness` for the per-item
// staleness verdict — which re-read the plan row, re-ran the browse check and
// re-read EVERY item (each carries its full proposed body) only to answer "all
// clear", because a plan that is not `planned` / `stale` has nothing to report.
// On the plan a poll watches that is the whole item set read twice more per tick.
//
// What is pinned is the COST and that nothing else moved:
//   · a `generating` plan's review read touches `plan_item` once, not twice, and
//     does not enter `computePlanStaleness` at all;
//   · its staleness is the same all-clear, per item, the old path returned;
//   · a `planned` plan still goes through `computePlanStaleness` (the verdict
//     that read exists to give), so the shortcut cannot hide a stale proposal.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function planWithItems(fx: WorkItemFixture, titles: string[]) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    titles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'task' as const, descriptionMd: `Body of ${title}` },
    })),
    fx.ctx,
  );
  return { planId: plan.id, itemIds: appended.items.map((i) => i.id) };
}

describe('getPlanReview on a generating plan (MOTIR-8103)', () => {
  it('reads the plan’s items ONCE and never enters computePlanStaleness', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRC' });
    const { planId } = await planWithItems(fx, ['A', 'B', 'C']);

    const itemReads = vi.spyOn(planItemRepository, 'findByPlan');
    const staleness = vi.spyOn(planStalenessService, 'computePlanStaleness');
    await planReviewService.getPlanReview(planId, fx.ctx);

    // The staleness verdict is built from the items `getPlanForReader` already read.
    expect(staleness).not.toHaveBeenCalled();
    // What is left is `getPlanForReader`'s read and the approval gate's proposal digest (the stamp a
    // press hands back). It was three reads before MOTIR-8103: the staleness copy is gone.
    expect(itemReads.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('does not re-read the plan row for the staleness check', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRD' });
    const { planId } = await planWithItems(fx, ['A']);

    const planReads = vi.spyOn(planRepository, 'findById');
    await planReviewService.getPlanReview(planId, fx.ctx);

    // Five reads before MOTIR-8103 (`getPlanForReader`, the staleness check, the live-progress row and two
    // from the approval gate); the staleness check's own copy is the one removed.
    expect(planReads.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('still reports every item not stale, as the staleness read did', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRE' });
    const { planId, itemIds } = await planWithItems(fx, ['A', 'B', 'C']);

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const expected = await planStalenessService.computePlanStaleness(planId, fx.ctx);

    expect(review.status).toBe('generating');
    expect(review.items.map((i) => i.planItemId).sort()).toEqual([...itemIds].sort());
    expect(expected.stale).toBe(false);
    expect(review.items.every((i) => i.stale === false)).toBe(true);
    expect(review.items.every((i) => (i.staleReasons ?? []).length === 0)).toBe(true);
  });

  it('a PLANNED plan still goes through computePlanStaleness', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRF' });
    const { planId } = await planWithItems(fx, ['A', 'B']);
    await plansService.markPlanned(planId, fx.ctx);

    const staleness = vi.spyOn(planStalenessService, 'computePlanStaleness');
    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(review.status).toBe('planned');
    expect(staleness).toHaveBeenCalledTimes(1);
  });
});
