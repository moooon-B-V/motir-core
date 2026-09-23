import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemPatch } from '@/lib/dto/plans';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6095 · MOTIR-6137 — the plan REVIEW model carries a leaf's
// DIFFICULTY (`design/ai-planning/design-notes.md` Part XX §20.8), asserted
// against the real service on real Postgres:
//
//   • `PlanReviewItemDto.difficulty` is the value approve will WRITE, on EVERY
//     op (ADR agent-authored-plans AMENDMENT 19 §4) — an `add`'s proposed value,
//     a `modify`'s patch when it carries the key (an explicit `null` clears it),
//     else the target's, and a `remove`'s target's.
//   • `buildChanges` emits a `difficulty` row, old → new in WIRE words, only when
//     the patch moves it — and `proposal.changedFields` is the same set.
//
// The renderers are driven off this shape in
// `tests/components/plan-review-difficulty.test.tsx`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedLeaf(
  fx: WorkItemFixture,
  title: string,
  difficulty: WorkItemDifficultyDto | null,
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, storyPoints: 3 },
    fx.ctx,
  );
  // The column, not the service path: these cases are about the REVIEW read,
  // not about 6016's write validation.
  if (difficulty) {
    await adminDb.workItem.update({ where: { id: dto.id }, data: { difficulty } });
  }
  return { id: dto.id, identifier: dto.identifier };
}

async function reviewOfModify(
  fx: WorkItemFixture,
  target: { id: string },
  patch: PlanItemPatch,
): Promise<PlanReviewItemDto> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: target.id, patch }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
  return review.items.find((i) => i.op === 'modify')!;
}

const difficultyRows = (item: PlanReviewItemDto) =>
  item.changes.filter((c) => c.field === 'difficulty');

describe('an `add` proposal', () => {
  it('carries each value of the scale, and none when it proposes none', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Adds' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        ...WORK_ITEM_DIFFICULTIES.map((difficulty) => ({
          op: 'add' as const,
          proposedFields: { title: `leaf-${difficulty}`, kind: 'task', difficulty },
        })),
        { op: 'add' as const, proposedFields: { title: 'leaf-none', kind: 'task' } },
        { op: 'add' as const, proposedFields: { title: 'a story', kind: 'story' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byTitle = new Map(review.items.map((i) => [i.title, i]));

    for (const d of WORK_ITEM_DIFFICULTIES) {
      const item = byTitle.get(`leaf-${d}`)!;
      expect(item.difficulty).toBe(d);
      // An `add` has no diff: the value rides the card, not a change row.
      expect(item.changes).toEqual([]);
    }
    expect(byTitle.get('leaf-none')!.difficulty).toBeNull();
    // A container carries none — MOTIR-6133 refuses one at the append.
    expect(byTitle.get('a story')!.difficulty).toBeNull();
  });
});

describe('a `modify` proposal', () => {
  it('low → high: a change row in wire words, the new value on the model, and in changedFields', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Sign the webhook payload', 'low');
    const item = await reviewOfModify(fx, target, { difficulty: 'high' });

    expect(difficultyRows(item)).toEqual([{ field: 'difficulty', from: 'low', to: 'high' }]);
    expect(item.difficulty).toBe('high');
    expect(item.proposal.changedFields).toContain('difficulty');
    expect(item.proposal.settableRailFields).toContain('difficulty');
  });

  it('medium → null CLEARS it: the row reads medium → null and the model carries null', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Retry the delivery', 'medium');
    const item = await reviewOfModify(fx, target, { difficulty: null });

    expect(difficultyRows(item)).toEqual([{ field: 'difficulty', from: 'medium', to: null }]);
    // PRESENCE, not nullishness: the explicit null is what approve writes.
    expect(item.difficulty).toBeNull();
  });

  it('none → medium SETS it: the from side is null', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Log the failure', null);
    const item = await reviewOfModify(fx, target, { difficulty: 'medium' });

    expect(difficultyRows(item)).toEqual([{ field: 'difficulty', from: null, to: 'medium' }]);
    expect(item.difficulty).toBe('medium');
  });

  it('a patch with NO difficulty key shows no row and reports the target’s value', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Rotate the secret', 'low');
    const item = await reviewOfModify(fx, target, { storyPoints: 5 });

    expect(difficultyRows(item)).toEqual([]);
    expect(item.proposal.changedFields).not.toContain('difficulty');
    expect(item.difficulty).toBe('low');
  });

  it('a patch that restates the current value shows no row', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Pin the version', 'high');
    const item = await reviewOfModify(fx, target, { difficulty: 'high' });

    expect(difficultyRows(item)).toEqual([]);
    expect(item.difficulty).toBe('high');
  });

  it('the row sits in the sizing group, directly after the estimate', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Size it', 'low');
    const item = await reviewOfModify(fx, target, {
      storyPoints: 8,
      estimateMinutes: 90,
      difficulty: 'high',
      title: 'Size it, again',
    });
    const fields = item.changes.map((c) => c.field).filter((f) => f !== 'status');
    expect(fields.indexOf('difficulty')).toBe(fields.indexOf('estimateMinutes') + 1);
  });
});

describe('a `remove` proposal', () => {
  it('reports the target’s value — the card as it stands', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedLeaf(fx, 'Drop the shim', 'trivial');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Prune' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: target.id }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const item = (await planReviewService.getPlanReview(plan.id, fx.ctx)).items[0]!;

    expect(item.op).toBe('remove');
    expect(item.difficulty).toBe('trivial');
    expect(difficultyRows(item)).toEqual([]);
  });
});
