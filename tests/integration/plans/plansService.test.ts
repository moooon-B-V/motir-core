import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanNotGeneratingError, PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

/** Seed a pre-existing work item through the real service, so it carries a
 *  valid fractional `position`/`backlogRank` (the test-fixture `createTestWorkItem`
 *  uses a non-fractional padded key that the materialize's append-after-sibling
 *  cannot extend). Returns the created id. */
async function seedItem(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

// Integration tests for Subtask 7.4.12 / MOTIR-1336 — `plansService`, the Plan
// substrate (Story 7.21). Real Postgres (no mocks), per CLAUDE.md. Proves:
//   • the lifecycle (generating → planned → approved|declined) + its guards;
//   • a PlanItem is a PROPOSAL — NOTHING in the work-item tree changes while a
//     plan is `planned` (no WorkItem for an add; modify/remove targets unchanged);
//   • approve MATERIALIZES per op — add → a new dispatchable WorkItem (intra-plan
//     parent + real/intra-plan blocker refs resolved), modify → same id + one
//     revision, remove → archived;
//   • decline drops all PlanItems with the tree untouched;
//   • concurrent approves resolve to exactly one materialize (atomic).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Create a plan, append the given proposals, and mark it `planned`. */
async function plannedPlan(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('plansService — lifecycle + proposals', () => {
  it('createPlan opens a generating plan; addProposals appends without touching the tree', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'A feature', sourceJobId: 'job_1' },
      fx.ctx,
    );
    expect(plan.status).toBe('generating');
    expect(plan.itemCount).toBe(0);
    expect(plan.sourceJobId).toBe('job_1');

    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'New task', kind: 'task' } }],
      fx.ctx,
    );
    expect(withItems.items).toHaveLength(1);
    expect(withItems.items[0]!.op).toBe('add');
    expect(withItems.items[0]!.workItemId).toBeNull();

    // Nothing in the work-item tree was created — the add lives only as a PlanItem.
    const created = await db.workItem.findFirst({ where: { title: 'New task' } });
    expect(created).toBeNull();
  });

  it('markPlanned moves generating → planned; addProposals afterwards is rejected', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'X' } }],
      fx.ctx,
    );
    const planned = await plansService.markPlanned(plan.id, fx.ctx);
    expect(planned.status).toBe('planned');
    expect(planned.plannedAt).not.toBeNull();
    expect(planned.itemCount).toBe(1);

    await expect(
      plansService.addProposals(plan.id, [{ op: 'add', proposedFields: { title: 'Y' } }], fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
  });

  it('getPlan returns the bundle + lifecycle history; listPlans paginates newest-first', async () => {
    const fx = await makeWorkItemFixture();
    const first = await plansService.createPlan(fx.projectId, { title: 'first' }, fx.ctx);
    const second = await plansService.createPlan(fx.projectId, { title: 'second' }, fx.ctx);

    const detail = await plansService.getPlan(first.id, fx.ctx);
    expect(detail.title).toBe('first');
    expect(detail.items).toEqual([]);

    const page = await plansService.listPlans(fx.projectId, fx.ctx, { limit: 1 });
    expect(page.plans).toHaveLength(1);
    expect(page.plans[0]!.id).toBe(second.id); // newest first
    expect(page.nextCursor).not.toBeNull();

    const page2 = await plansService.listPlans(fx.projectId, fx.ctx, {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(page2.plans).toHaveLength(1);
    expect(page2.plans[0]!.id).toBe(first.id);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('plansService.approvePlan — materialize per op', () => {
  it('materializes an add: a new dispatchable WorkItem, intra-plan + real refs resolved, id written back, revision logged', async () => {
    const fx = await makeWorkItemFixture();
    // A real existing work item the add will be blocked_by (real-ref resolution).
    const blockerId = await seedItem(fx, 'Existing blocker');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Tree' }, fx.ctx);
    // Add A: a parent story.
    const afterA = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Parent story', kind: 'story' } }],
      fx.ctx,
    );
    const storyItemId = afterA.items[0]!.id;
    // Add B: a subtask under A (intra-plan parent ref) blocked_by the real blocker.
    const afterB = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Child task', kind: 'subtask', type: 'code', priority: 'high' },
          parentRef: `planItem:${storyItemId}`,
          blockedByRefs: [blockerId],
        },
      ],
      fx.ctx,
    );
    const childItemId = afterB.items.find((i) => i.proposedFields?.title === 'Child task')!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    // While planned, neither add exists in the tree.
    expect(await db.workItem.findFirst({ where: { title: 'Parent story' } })).toBeNull();

    const approved = await plansService.approvePlan(plan.id, fx.ctx);
    expect(approved.status).toBe('approved');
    expect(approved.decidedById).toBe(fx.ownerId);
    expect(approved.decidedAt).not.toBeNull();

    // The story + child now exist, dispatchable (real identifier/status/reporter).
    const story = await db.workItem.findFirst({ where: { title: 'Parent story' } });
    const child = await db.workItem.findFirst({ where: { title: 'Child task' } });
    expect(story).not.toBeNull();
    expect(child).not.toBeNull();
    expect(child!.parentId).toBe(story!.id); // intra-plan parent ref resolved
    expect(child!.kind).toBe('subtask');
    expect(child!.type).toBe('code');
    expect(child!.priority).toBe('high');
    expect(child!.identifier).toMatch(/^PROD-\d+$/);
    expect(child!.status).not.toBe('');
    expect(child!.reporterId).toBe(fx.ownerId);

    // The blocked_by link to the REAL existing blocker was created.
    const link = await db.workItemLink.findFirst({
      where: { fromId: child!.id, toId: blockerId, kind: 'is_blocked_by' },
    });
    expect(link).not.toBeNull();

    // The PlanItems carry the written-back work-item ids; a 'created' revision logged.
    const finalChild = approved.items.find((i) => i.id === childItemId)!;
    expect(finalChild.workItemId).toBe(child!.id);
    const revisions = await db.workItemRevision.findMany({ where: { workItemId: child!.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.changeKind).toBe('created');
  });

  it('materializes a modify: SAME id, fields updated, exactly ONE revision; and a remove: target archived', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Old title');
    const doomedId = await seedItem(fx, 'To remove');

    const blockerId = await seedItem(fx, 'Blocker for modify');
    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: targetId,
        patch: { title: 'New title', priority: 'high', blockedByAdd: [blockerId] },
      },
      { op: 'remove', workItemId: doomedId },
    ]);

    // While planned, the modify/remove targets are byte-for-byte unchanged.
    const beforeModify = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(beforeModify.title).toBe('Old title');
    expect(
      (await db.workItem.findUniqueOrThrow({ where: { id: doomedId } })).archivedAt,
    ).toBeNull();

    await plansService.approvePlan(planId, fx.ctx);

    const modified = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(modified.id).toBe(targetId); // identity never re-minted
    expect(modified.title).toBe('New title');
    expect(modified.priority).toBe('high');

    // The edge change applied: an is_blocked_by link to the blocker now exists.
    const link = await db.workItemLink.findFirst({
      where: { fromId: targetId, toId: blockerId, kind: 'is_blocked_by' },
    });
    expect(link).not.toBeNull();

    // Exactly ONE `updated` revision for the whole modify (the seed `created`
    // one aside) — the modify lands as a single entry, same id — and the edge
    // change rides it under the existing `links` diff key.
    const modRevisions = await db.workItemRevision.findMany({
      where: { workItemId: targetId, changeKind: 'updated' },
    });
    expect(modRevisions).toHaveLength(1);
    expect(modRevisions[0]!.diff).toMatchObject({
      links: { added: [{ toId: blockerId, kind: 'is_blocked_by' }] },
    });

    const removed = await db.workItem.findUniqueOrThrow({ where: { id: doomedId } });
    expect(removed.archivedAt).not.toBeNull();
  });
});

describe('plansService.declinePlan', () => {
  it('drops all PlanItems and leaves the work-item tree untouched', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Untouched');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Never created', kind: 'task' } },
      { op: 'modify', workItemId: targetId, patch: { title: 'Should not apply' } },
    ]);

    const declined = await plansService.declinePlan(planId, fx.ctx);
    expect(declined.status).toBe('declined');
    expect(declined.decidedById).toBe(fx.ownerId);

    // The add was never materialized; the modify target is unchanged; items dropped.
    expect(await db.workItem.findFirst({ where: { title: 'Never created' } })).toBeNull();
    expect((await db.workItem.findUniqueOrThrow({ where: { id: targetId } })).title).toBe(
      'Untouched',
    );
    expect(await db.planItem.count({ where: { planId } })).toBe(0);
  });

  it('rejects approve/decline from a non-planned status', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    // still generating
    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );
    await expect(plansService.declinePlan(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );
  });
});

describe('plansService.approvePlan — concurrency (atomic one-shot)', () => {
  it('two concurrent approves materialize exactly once; the loser gets a typed error', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Once only', kind: 'task' } },
    ]);

    const results = await Promise.allSettled([
      plansService.approvePlan(planId, fx.ctx),
      plansService.approvePlan(planId, fx.ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser fails with a typed error (no raw DB race escapes).
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );

    // The add materialized EXACTLY once (no double-create).
    const created = await db.workItem.findMany({ where: { title: 'Once only' } });
    expect(created).toHaveLength(1);

    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.status).toBe('approved');
  });
});
