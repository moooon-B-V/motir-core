import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6055 — the REVIEW MODEL names what AMENDMENT 18 lets a plan say, against
// real Postgres (`design/ai-planning/design-notes.md` Part XIX §19.7).
//
// Two seams: a `modify` moving a committed card under a PROPOSED `add` names that
// parent by the add's TITLE (the surface draws `New · <title>`) until approve
// creates it, and by the created KEY after — never the `planItem:` temp-ref; and
// a `remove`'s reason reaches both the item and the peek envelope, verbatim.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'subtask',
  parentId?: string,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

/** A plan that adds a story under `epic` and moves `card` under it. */
async function moveUnderProposedStory(fx: WorkItemFixture) {
  const epic = await seedItem(fx, 'The epic', 'epic');
  const home = await seedItem(fx, 'Where it is', 'story', epic);
  const card = await seedItem(fx, 'The card', 'subtask', home);
  const plan = await plansService.createPlan(fx.projectId, { title: 'Move' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', parentRef: epic, proposedFields: { title: 'The new story', kind: 'story' } }],
    fx.ctx,
  );
  const story = (await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id, op: 'add' } }))
    .id;
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: card, patch: { parentRef: `${TEMP_REF_PREFIX}${story}` } }],
    fx.ctx,
  );
  return { planId: plan.id, card };
}

async function modifyOf(planId: string, fx: WorkItemFixture): Promise<PlanReviewItemDto> {
  const review = await planReviewService.getPlanReview(planId, fx.ctx);
  return review.items.find((i) => i.op === 'modify')!;
}

describe('a card moved under a PROPOSED parent (Part XIX §19.3)', () => {
  it('names the parent by the add’s TITLE and never by its temp-ref', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await moveUnderProposedStory(fx);

    const item = await modifyOf(planId, fx);
    const parent = item.changes.find((c) => c.field === 'parent')!;
    expect(parent.to).toBe('The new story');
    expect(parent.placement?.to).toMatchObject({
      kind: 'workItem',
      identifier: null,
      proposedTitle: 'The new story',
    });
    expect(JSON.stringify(item.changes)).not.toContain(`"to":"${TEMP_REF_PREFIX}`);
  });

  it('after APPROVE names it by the key approve created', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await moveUnderProposedStory(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'The new story' },
    });
    const parent = (await modifyOf(planId, fx)).changes.find((c) => c.field === 'parent')!;
    expect(parent.to).toBe(created.identifier);
    expect(parent.placement?.to).toMatchObject({
      kind: 'workItem',
      identifier: created.identifier,
    });
    expect(parent.placement?.to).not.toHaveProperty('proposedTitle');
  });

  it('after DECLINE still names the proposed parent — nothing was created', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await moveUnderProposedStory(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.declinePlan(planId, fx.ctx);

    const parent = (await modifyOf(planId, fx)).changes.find((c) => c.field === 'parent')!;
    expect(parent.placement?.to).toMatchObject({
      identifier: null,
      proposedTitle: 'The new story',
    });
  });
});

describe('a remove’s REASON (Part XIX §19.5)', () => {
  it('rides the item AND the peek envelope, verbatim; null everywhere else', async () => {
    const fx = await makeWorkItemFixture();
    const gone = await seedItem(fx, 'Legacy CSV export', 'task');
    const quiet = await seedItem(fx, 'Old report', 'task');
    const kept = await seedItem(fx, 'Kept', 'task');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Prune' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'remove', workItemId: gone, reason: 'Replaced by the JSON export.' },
        { op: 'remove', workItemId: quiet },
        { op: 'modify', workItemId: kept, patch: { title: 'Kept, renamed' } },
      ],
      fx.ctx,
    );

    const { items } = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byTitle = Object.fromEntries(
      items.map((i) => [i.title, [i.removeReason, i.proposal.removeReason]]),
    );
    expect(byTitle).toEqual({
      'Legacy CSV export': ['Replaced by the JSON export.', 'Replaced by the JSON export.'],
      'Old report': [null, null],
      'Kept, renamed': [null, null],
    });
  });
});
