import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-8127 — what a poll of a `generating` plan costs, counted rather than timed.
//
// Timings on a loopback database are noise (MOTIR-8103 measured 30 ms and 95 ms medians for the same
// read on consecutive runs); what is stable, and what a deployed database multiplies by its round-trip
// latency, is the NUMBER OF TRANSACTIONS a read opens — each `withWorkspaceServiceContext` is a BEGIN,
// a `set_config` and a COMMIT around its statements — and the number of times the plan's items are read.
//
// Measured on this tree for a 3-card generating plan:
//
//     full review read   24 transactions → 16      (the independent reads share one; the edge, target
//                                                   and ancestor reads share one; the projection no
//                                                   longer admits the reader and loads every item again)
//     item reads          2 → 1
//     unchanged answer    —  → 4 and NO item read, NO review assembly
//
// The numbers are PINNED as ceilings so a change that adds a transaction to the poll has to say so.

const FULL_READ_TRANSACTIONS = 16;
const UNCHANGED_TRANSACTIONS = 4;

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

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    ['A', 'B', 'C'].map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'task' as const, descriptionMd: `Body of ${title}` },
    })),
    fx.ctx,
  );
  return plan.id;
}

describe('what a poll of a generating plan costs (MOTIR-8127)', () => {
  it('the full review read opens no more than the pinned transactions and reads the items once', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RVT' });
    const planId = await generatingPlan(fx);

    const transactions = vi.spyOn(db, '$transaction');
    const itemReads = vi.spyOn(planItemRepository, 'findByPlan');
    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(review.status).toBe('generating');
    expect(review.items).toHaveLength(3);
    // The projection reuses the plan the review already admitted and loaded: ONE read of the items.
    expect(itemReads).toHaveBeenCalledTimes(1);
    expect(transactions.mock.calls.length).toBeLessThanOrEqual(FULL_READ_TRANSACTIONS);
  });

  it('the unchanged answer opens no more than the pinned transactions and reads no item', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RVU' });
    const planId = await generatingPlan(fx);
    const { reviewVersion } = await planReviewService.getPlanReview(planId, fx.ctx);

    const transactions = vi.spyOn(db, '$transaction');
    const itemReads = vi.spyOn(planItemRepository, 'findByPlan');
    const answer = await planReviewService.getPlanReviewIfChanged(planId, fx.ctx, reviewVersion!);

    expect(answer).toEqual({ unchanged: true, reviewVersion });
    expect(itemReads).not.toHaveBeenCalled();
    expect(transactions.mock.calls.length).toBeLessThanOrEqual(UNCHANGED_TRANSACTIONS);
  });

  it('a PLANNED plan’s review is not polled, so it keeps the staleness verdict’s and the digest’s item reads', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RVV' });
    const planId = await generatingPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const itemReads = vi.spyOn(planItemRepository, 'findByPlan');
    await planReviewService.getPlanReview(planId, fx.ctx);

    // The review's own read, the staleness verdict's (only an undecided plan can be stale) and the
    // approval gate's proposal digest (the stamp a press hands back). The last two exist only once the
    // plan is `planned` — which is why a `generating` poll never pays them, and why the gate digest's
    // item read is not what MOTIR-8103 took the second read on a generating plan to be.
    expect(itemReads).toHaveBeenCalledTimes(3);
  });
});
