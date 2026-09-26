import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6362 — the plan-review model judges each off-level edge over the
// PROJECTED tree, with the roadmap's own disposition rule (MOTIR-6359): a
// proposal's blocker stub carries `coverage`, and the committed edges whose
// parents' edge the plan adds or removes arrive as `edgeCoverage` overrides.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seed(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'subtask',
  title: string,
  parentId?: string,
) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

async function link(fx: WorkItemFixture, blockedId: string, blockerId: string) {
  await adminDb.workItemLink.create({
    data: {
      fromId: blockedId,
      toId: blockerId,
      kind: 'is_blocked_by',
      workspaceId: fx.workspaceId,
      createdById: fx.ctx.userId,
    },
  });
}

/** E ─ A ─ a1  ·  E ─ B ─ b1 */
async function tree(fx: WorkItemFixture) {
  const E = await seed(fx, 'epic', 'Checkout');
  const A = await seed(fx, 'story', 'Payments API', E.id);
  const B = await seed(fx, 'story', 'Checkout flow', E.id);
  const a1 = await seed(fx, 'subtask', 'Tokenise', A.id);
  const b1 = await seed(fx, 'subtask', 'Charge', B.id);
  return { E, A, B, a1, b1 };
}

describe('planReviewService.getPlanReview — projected edge disposition (MOTIR-6362)', () => {
  it('a proposal blocked across stories is UNCOVERED when the plan does not link the stories', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);

    const bare = await plansService.createPlan(fx.projectId, { title: 'Bare' }, fx.ctx);
    await plansService.addProposals(
      bare.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Receipt', kind: 'subtask' },
          parentRef: t.B.id,
          blockedByRefs: [t.a1.id],
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(bare.id, fx.ctx);
    const review = await planReviewService.getPlanReview(bare.id, fx.ctx);
    const stub = review.items[0]!.blockerStubs.find((s) => s.nodeId === t.a1.id)!;
    expect(stub.coverage).toBe('uncovered');
  });

  it('the same proposal is COVERED when the plan also links the stories (`blockedByAdd`)', async () => {
    // A fixture of its own: a planned plan HOLDS the cards it touches, so a second
    // plan on the same story would be refused (`PlanTargetLockedError`).
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const wired = await plansService.createPlan(fx.projectId, { title: 'Wired' }, fx.ctx);
    await plansService.addProposals(
      wired.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Receipt', kind: 'subtask' },
          parentRef: t.B.id,
          blockedByRefs: [t.a1.id],
        },
        { op: 'modify', workItemId: t.B.id, patch: { blockedByAdd: [t.A.id] } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(wired.id, fx.ctx);
    const review = await planReviewService.getPlanReview(wired.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.blockerStubs.find((s) => s.nodeId === t.a1.id)!.coverage).toBe('covered');
  });

  it('a plan REMOVING the stories’ edge re-judges the committed child edge as UNCOVERED', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.b1.id, t.a1.id);
    await link(fx, t.B.id, t.A.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Unwire' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: t.B.id, patch: { blockedByRemove: [t.A.id] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.edgeCoverage).toEqual([
      { blockedId: t.b1.id, blockerId: t.a1.id, coverage: 'uncovered' },
    ]);
  });

  it('a plan ADDING the stories’ edge re-judges the committed child edge as COVERED', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.b1.id, t.a1.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Wire' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: t.B.id, patch: { blockedByAdd: [t.A.id] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.edgeCoverage).toEqual([
      { blockedId: t.b1.id, blockerId: t.a1.id, coverage: 'covered' },
    ]);
  });

  it('a plan touching no parent edge re-judges nothing', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await link(fx, t.b1.id, t.a1.id);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Rename' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: t.B.id, patch: { title: 'Checkout flow v2' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.edgeCoverage).toEqual([]);
  });
});
