import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { patchRescopes, resetOwed } from '@/lib/plans/rescopeReset';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-5359 — an approved `modify` that RE-SCOPES an in-progress-category
// work item sends it back to To Do, on real Postgres through the approve service.
//
// Seen on MOTIR-4906's re-plan: six `implemented` cards were rewritten to a new
// shape, stayed `implemented`, and had to be rolled back by hand. The cases are
// the rule's edges: which fields reset (title, description, repository), which do
// not (type, estimate, points, edges, priority), which statuses reset (the
// in-progress category), which do not (todo, done), atomicity, and the review
// row the approver sees first.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedAt(fx: WorkItemFixture, title: string, status: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, type: 'code' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status } });
  return dto.id;
}

async function approveModify(
  fx: WorkItemFixture,
  workItemId: string,
  patch: Record<string, unknown>,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return plan.id;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('plansService.approvePlan — a re-scope resets an in-progress card to To Do (MOTIR-5359)', () => {
  it('an IMPLEMENTED card whose description is rewritten lands at To Do, with a status revision', async () => {
    const fx = await makeWorkItemFixture();
    const id = await seedAt(fx, 'Built on the old shape', 'implemented');

    await approveModify(fx, id, { descriptionMd: 'The new shape.' });

    expect(await statusOf(id)).toBe('todo');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: id },
      orderBy: { changedAt: 'asc' },
    });
    const statusMove = revisions.findLast(
      (r) => (r.diff as { status?: { from: string; to: string } }).status !== undefined,
    );
    expect((statusMove?.diff as { status: { from: string; to: string } }).status).toEqual({
      from: 'implemented',
      to: 'todo',
    });
  });

  it.each(['in_progress', 'in_review', 'approved', 'planning'])(
    'a %s card whose TITLE is rewritten lands at To Do',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const id = await seedAt(fx, 'Old title', status);
      await approveModify(fx, id, { title: 'New title' });
      expect(await statusOf(id)).toBe('todo');
    },
  );

  it('a re-pin of where the card ships resets it too', async () => {
    const fx = await makeWorkItemFixture();
    const id = await seedAt(fx, 'Ships elsewhere', 'implemented');
    // An unpin is the re-pin a fixture without connected repositories can express.
    await adminDb.workItem.update({ where: { id }, data: { targetRepo: 'old-repo' } });
    await approveModify(fx, id, { targetRepo: null });
    expect(await statusOf(id)).toBe('todo');
  });

  it.each([
    ['type only', { type: 'test' }],
    ['estimate only', { estimateMinutes: 45 }],
    ['story points only', { storyPoints: 3 }],
    ['priority only', { priority: 'high' }],
    ['explanation only', { explanationMd: 'A new why.' }],
  ] as const)('an IMPLEMENTED card patched with %s keeps its status', async (_label, patch) => {
    const fx = await makeWorkItemFixture();
    const id = await seedAt(fx, 'Resized, not re-scoped', 'implemented');
    await approveModify(fx, id, patch);
    expect(await statusOf(id)).toBe('implemented');
  });

  it('an edge-only modify keeps an IMPLEMENTED card implemented', async () => {
    const fx = await makeWorkItemFixture();
    const id = await seedAt(fx, 'Rewired', 'implemented');
    const blocker = await seedAt(fx, 'A blocker', 'todo');
    await approveModify(fx, id, { blockedByAdd: [blocker] });
    expect(await statusOf(id)).toBe('implemented');
  });

  it('a TODO card and a DONE card keep their statuses under a re-scope', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await seedAt(fx, 'Not started', 'todo');
    const blocked = await seedAt(fx, 'Waiting', 'blocked');
    await approveModify(fx, todo, { descriptionMd: 'Rewritten.' });
    await approveModify(fx, blocked, { descriptionMd: 'Rewritten.' });
    expect(await statusOf(todo)).toBe('todo');
    expect(await statusOf(blocked)).toBe('blocked');

    // A done target is refused by the approve's own terminal guard or left
    // alone — either way its status must not move.
    const done = await seedAt(fx, 'Finished', 'done');
    await approveModify(fx, done, { descriptionMd: 'Rewritten.' }).catch(() => undefined);
    expect(await statusOf(done)).toBe('done');
  });

  it('the approve stays ONE transaction: a failure after the reset rolls the status back too', async () => {
    const fx = await makeWorkItemFixture();
    const id = await seedAt(fx, 'Rolled back', 'implemented');
    const doomed = await seedAt(fx, 'Deleted before approve', 'todo');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Half fails' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: id, patch: { descriptionMd: 'Rewritten.' } },
        { op: 'modify', workItemId: doomed, patch: { title: 'Gone' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    // The SECOND target disappears, so the approve fails AFTER the first modify's
    // reset has been written inside the transaction.
    await adminDb.workItem.delete({ where: { id: doomed } });
    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow();
    expect(await statusOf(id)).toBe('implemented');
  });
});

describe('planReviewService — the approver SEES the reset before approving (MOTIR-5359)', () => {
  it('a re-scope of an in-progress target shows a status row; an edge-only modify shows none', async () => {
    const fx = await makeWorkItemFixture();
    const rescoped = await seedAt(fx, 'Rescoped', 'implemented');
    const rewired = await seedAt(fx, 'Rewired', 'implemented');
    const blocker = await seedAt(fx, 'Blocker', 'todo');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Review' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: rescoped, patch: { descriptionMd: 'New body.' } },
        { op: 'modify', workItemId: rewired, patch: { blockedByAdd: [blocker] } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const rowFor = (workItemId: string) =>
      review.items.find((i) => i.nodeId === workItemId)!.changes.find((c) => c.field === 'status');
    expect(rowFor(rescoped)).toEqual({ field: 'status', from: 'Implemented', to: 'To Do' });
    expect(rowFor(rewired)).toBeUndefined();
  });
});

describe('patchRescopes / resetOwed — the one predicate', () => {
  const target = { title: 'T', descriptionMd: 'D' };
  it('counts a changed title or description, and any repository key', () => {
    expect(patchRescopes({ title: 'T' }, target)).toBe(false);
    expect(patchRescopes({ title: 'U' }, target)).toBe(true);
    expect(patchRescopes({ descriptionMd: 'D' }, target)).toBe(false);
    expect(patchRescopes({ descriptionMd: null }, target)).toBe(true);
    expect(patchRescopes({ targetRepoRole: 'web' }, target)).toBe(true);
    expect(patchRescopes({}, target)).toBe(false);
  });
  it('owes a reset only in the in-progress category', () => {
    expect(resetOwed('in_progress')).toBe(true);
    expect(resetOwed('todo')).toBe(false);
    expect(resetOwed('done')).toBe(false);
    expect(resetOwed(undefined)).toBe(false);
  });
});
