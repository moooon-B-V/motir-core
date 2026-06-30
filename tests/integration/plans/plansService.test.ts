import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  InvalidProposalError,
  PlanItemNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { InvalidEstimateError } from '@/lib/estimation/errors';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
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

  it('normalizes a bare REAL work-item key in a materialized description to the canonical chip token (bug MOTIR-1440)', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Referenced target');
    const target = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });

    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Generated card',
          kind: 'task',
          descriptionMd: `Builds on ${target.identifier} — see there.`,
        },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await db.workItem.findFirstOrThrow({ where: { title: 'Generated card' } });
    // The bare key was rewritten to the chip token (resolved against the real item).
    expect(created.descriptionMd).toBe(
      `Builds on [${target.identifier}](motir:${target.id}) — see there.`,
    );
  });

  it('normalizes a bare REAL key in a materialized MODIFY patch description (bug MOTIR-1440)', async () => {
    const fx = await makeWorkItemFixture();
    const editTargetId = await seedItem(fx, 'Edit me');
    const refId = await seedItem(fx, 'Ref target');
    const ref = await db.workItem.findUniqueOrThrow({ where: { id: refId } });

    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: editTargetId,
        patch: { descriptionMd: `Now mentions ${ref.identifier}.` },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const modified = await db.workItem.findUniqueOrThrow({ where: { id: editTargetId } });
    expect(modified.descriptionMd).toBe(`Now mentions [${ref.identifier}](motir:${ref.id}).`);
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

// Subtask 7.21.6 / MOTIR-1370 — edit a proposed `add` in place while the plan is
// `planned`. A PlanItem is a PROPOSAL: editing patches its `proposedFields`; no
// WorkItem is created (that waits for approve). Real Postgres.
describe('plansService.updateProposal — edit a proposed add (7.21.6)', () => {
  it('edits a planned plan’s add proposal in place; no WorkItem is created', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Old title', kind: 'task', priority: 'low' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    const updated = await plansService.updateProposal(
      plan.id,
      itemId,
      {
        title: 'New title',
        kind: 'story',
        priority: 'high',
        type: 'design',
        descriptionMd: 'Why this matters',
      },
      fx.ctx,
    );
    const edited = updated.items.find((i) => i.id === itemId)!;
    expect(edited.proposedFields).toMatchObject({
      title: 'New title',
      kind: 'story',
      priority: 'high',
      type: 'design',
      descriptionMd: 'Why this matters',
    });
    // Still a proposal — neither the old nor the new title exists in the tree.
    expect(await db.workItem.findFirst({ where: { title: 'New title' } })).toBeNull();
    expect(await db.workItem.findFirst({ where: { title: 'Old title' } })).toBeNull();
  });

  it('merges sparsely — an absent key is left untouched', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Keep me', kind: 'task', priority: 'low' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    const updated = await plansService.updateProposal(
      plan.id,
      itemId,
      { priority: 'highest' },
      fx.ctx,
    );
    const edited = updated.items.find((i) => i.id === itemId)!;
    expect(edited.proposedFields?.title).toBe('Keep me'); // untouched
    expect(edited.proposedFields?.kind).toBe('task'); // untouched
    expect(edited.proposedFields?.priority).toBe('highest'); // changed
  });

  it('rejects an edit that would empty the title (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Has a title', kind: 'task' } },
    ]);
    const item = (await plansService.getPlan(planId, fx.ctx)).items[0]!;
    await expect(
      plansService.updateProposal(planId, item.id, { title: '   ' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects editing a non-add (modify) proposal (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Existing target');
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'X' }, baseRevision: 'r1' }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(plan.id, itemId, { title: 'Y' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects an unknown plan item (PlanItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'A', kind: 'task' } },
    ]);
    await expect(
      plansService.updateProposal(planId, 'pi_does_not_exist', { title: 'Z' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanItemNotFoundError);
  });

  it('rejects when the plan is not planned (generating, then approved)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A', kind: 'task' } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    // generating
    await expect(
      plansService.updateProposal(plan.id, itemId, { title: 'B' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotInExpectedStatusError);
    // approved (immutable)
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(plan.id, itemId, { title: 'C' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotInExpectedStatusError);
  });

  it('enforces canEdit — a non-member is denied', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'A', kind: 'task' } },
    ]);
    const item = (await plansService.getPlan(planId, fx.ctx)).items[0]!;
    const outsider = await createTestUser();
    const outsiderCtx = { userId: outsider.id, workspaceId: fx.ctx.workspaceId };
    await expect(
      plansService.updateProposal(planId, item.id, { title: 'B' }, outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});

describe('plansService.deepenProposal — deepen a proposed add while generating (7.4.4a)', () => {
  /** Open a `generating` plan with one title-only `add` (the titles-first Phase
   *  1 shape) and return { planId, itemId }. NOT marked planned — the deepen
   *  runs while still generating. */
  async function generatingAdd(
    fx: WorkItemFixture,
    proposedFields: { title: string; kind?: string } = { title: 'Title only', kind: 'story' },
  ): Promise<{ planId: string; itemId: string }> {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Gen' }, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields }],
      fx.ctx,
    );
    return { planId: plan.id, itemId: withItems.items[0]!.id };
  }

  it('patches a generating plan’s add in place (Phase-2 deepen); no WorkItem, stays generating', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);

    const updated = await plansService.deepenProposal(
      planId,
      itemId,
      {
        descriptionMd: 'The full card body, written now.',
        type: 'code',
        priority: 'high',
        storyPoints: 5,
        estimateMinutes: 55,
      },
      fx.ctx,
    );
    const edited = updated.items.find((i) => i.id === itemId)!;
    expect(edited.proposedFields).toMatchObject({
      title: 'Title only', // untouched
      descriptionMd: 'The full card body, written now.',
      type: 'code',
      priority: 'high',
      storyPoints: 5,
      estimateMinutes: 55,
    });
    // Still a proposal, and the plan is still open for more appends.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    expect((await db.plan.findFirst({ where: { id: planId } }))!.status).toBe('generating');
  });

  it('merges sparsely — an explicit null clears the estimate, an absent key is untouched', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await plansService.deepenProposal(
      planId,
      itemId,
      { storyPoints: 3, estimateMinutes: 30 },
      fx.ctx,
    );

    const cleared = await plansService.deepenProposal(
      planId,
      itemId,
      { estimateMinutes: null },
      fx.ctx,
    );
    const item = cleared.items.find((i) => i.id === itemId)!;
    expect(item.proposedFields?.storyPoints).toBe(3); // untouched
    expect(item.proposedFields?.estimateMinutes).toBeNull(); // cleared
    expect(item.proposedFields?.title).toBe('Title only'); // untouched
  });

  it('rejects once the plan is no longer generating (planned)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.deepenProposal(planId, itemId, { descriptionMd: 'too late' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotInExpectedStatusError);
  });

  it('rejects an edit that would empty the title (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await expect(
      plansService.deepenProposal(planId, itemId, { title: '   ' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects deepening a non-add (modify) proposal (InvalidProposalError)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Existing');
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'X' }, baseRevision: 'r1' }],
      fx.ctx,
    );
    await expect(
      plansService.deepenProposal(plan.id, withItems.items[0]!.id, { title: 'Y' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('rejects an unknown plan item (PlanItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingAdd(fx);
    await expect(
      plansService.deepenProposal(planId, 'pi_missing', { title: 'Z' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanItemNotFoundError);
  });

  it('rejects a patched-in bad estimate (InvalidEstimateError)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    await expect(
      plansService.deepenProposal(planId, itemId, { estimateMinutes: -5 }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidEstimateError); // minutes must be a non-negative integer
  });

  it('enforces canEdit — a non-member is denied', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await generatingAdd(fx);
    const outsider = await createTestUser();
    const outsiderCtx = { userId: outsider.id, workspaceId: fx.ctx.workspaceId };
    await expect(
      plansService.deepenProposal(planId, itemId, { descriptionMd: 'x' }, outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});

describe('plansService.updateProposal — concurrency (edit vs approve)', () => {
  it('an edit racing an approve resolves consistently: plan approved once, one work item, no raw race', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Race', kind: 'task' } },
    ]);
    const item = (await plansService.getPlan(planId, fx.ctx)).items[0]!;

    const results = await Promise.allSettled([
      plansService.approvePlan(planId, fx.ctx),
      plansService.updateProposal(planId, item.id, { title: 'Edited mid-approve' }, fx.ctx),
    ]);

    // Both lock the plan row, so they serialize: either the edit lands first then
    // approve materializes the edited add (both succeed), or approve lands first
    // and the edit observes `approved` and throws the typed guard. Never a raw race.
    const rejected = results.filter((r) => r.status === 'rejected');
    rejected.forEach((r) =>
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PlanNotInExpectedStatusError),
    );
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.status).toBe('approved');
    // Exactly ONE work item materialized (no double-create, no orphan), titled by
    // whichever ordering won.
    const created = await db.workItem.findMany({
      where: { projectId: fx.projectId, title: { in: ['Race', 'Edited mid-approve'] } },
    });
    expect(created).toHaveLength(1);
  });
});

// The immutable onboarding-ran marker (Subtask 7.4 / MOTIR-1264): approving the
// project's FIRST plan stamps `project.onboardingRanAt` (the single source of
// truth the /onboarding redirect AND the roadmap planning-origin cluster read);
// it is SET-ONCE — never re-written by a later approve — and a plan that never
// materializes (declined) never stamps it.
describe('plansService.approvePlan — onboarding-ran marker (MOTIR-1264)', () => {
  it('stamps onboardingRanAt on the FIRST plan approve + materialize', async () => {
    const fx = await makeWorkItemFixture();
    const before = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(before.onboardingRanAt).toBeNull(); // a fresh project never onboarded

    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'First tree', kind: 'task' } },
    ]);
    const t0 = Date.now();
    await plansService.approvePlan(planId, fx.ctx);

    const after = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(after.onboardingRanAt).toBeInstanceOf(Date);
    // Stamped with the approval moment (allow generous clock slack on a slow CI box).
    expect(Math.abs(after.onboardingRanAt!.getTime() - t0)).toBeLessThan(60_000);
  });

  it('is immutable — a SECOND approved plan never re-stamps the marker', async () => {
    const fx = await makeWorkItemFixture();

    const planA = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree A', kind: 'task' } },
    ]);
    await plansService.approvePlan(planA, fx.ctx);
    const firstStamp = (await db.project.findUniqueOrThrow({ where: { id: fx.projectId } }))
      .onboardingRanAt;
    expect(firstStamp).toBeInstanceOf(Date);

    // A later, separately-approved plan on the SAME project must NOT move the
    // marker — the null-guarded write is a no-op once the stamp exists.
    const planB = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Tree B', kind: 'task' } },
    ]);
    await plansService.approvePlan(planB, fx.ctx);
    const secondStamp = (await db.project.findUniqueOrThrow({ where: { id: fx.projectId } }))
      .onboardingRanAt;
    expect(secondStamp!.getTime()).toBe(firstStamp!.getTime());
  });

  it('a DECLINED plan never stamps the marker (no materialize → never onboarded)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Dropped', kind: 'task' } },
    ]);
    await plansService.declinePlan(planId, fx.ctx);

    const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.onboardingRanAt).toBeNull();
  });
});

// Bug MOTIR-1433 — the Plan substrate must CARRY leaf sizing (storyPoints +
// estimateMinutes, the estimation gate) on a proposed `add`, round-trip it
// through getPlan, MAP it onto the materialized WorkItem, and let updateProposal
// patch it. Real Postgres.
describe('plansService — leaf sizing on proposals (MOTIR-1433)', () => {
  it('round-trips storyPoints + estimateMinutes: addProposals → getPlan → materialize onto the WorkItem', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Sized' }, fx.ctx);
    const after = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Sized leaf',
            kind: 'task',
            type: 'code',
            storyPoints: 5,
            estimateMinutes: 55,
          },
        },
      ],
      fx.ctx,
    );
    // The proposal carries the sizing (the DTO round-trips it from the JSON column).
    expect(after.items[0]!.proposedFields).toMatchObject({ storyPoints: 5, estimateMinutes: 55 });

    // getPlan reads it back identically (no WorkItem yet).
    const reread = await plansService.getPlan(plan.id, fx.ctx);
    expect(reread.items[0]!.proposedFields).toMatchObject({ storyPoints: 5, estimateMinutes: 55 });

    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    // Materialize mapped the sizing onto the created WorkItem (the gate survives).
    const created = await db.workItem.findFirstOrThrow({ where: { title: 'Sized leaf' } });
    expect(Number(created.storyPoints)).toBe(5);
    expect(created.estimateMinutes).toBe(55);

    // The 'created' revision records the sizing (mirrors the normal create diff).
    const rev = await db.workItemRevision.findFirstOrThrow({
      where: { workItemId: created.id, changeKind: 'created' },
    });
    expect(rev.diff).toMatchObject({
      storyPoints: { from: null, to: 5 },
      estimateMinutes: { from: null, to: 55 },
    });
  });

  it('an add with no sizing materializes an unestimated WorkItem (sizing stays null)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Unsized', kind: 'task' } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const created = await db.workItem.findFirstOrThrow({ where: { title: 'Unsized' } });
    expect(created.storyPoints).toBeNull();
    expect(created.estimateMinutes).toBeNull();
  });

  it('updateProposal patches sizing in place; an explicit null clears it', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Resize me', kind: 'subtask', storyPoints: 2 } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);

    // Patch the point value + set a minute estimate.
    const patched = await plansService.updateProposal(
      plan.id,
      itemId,
      { storyPoints: 8, estimateMinutes: 90 },
      fx.ctx,
    );
    expect(patched.items.find((i) => i.id === itemId)!.proposedFields).toMatchObject({
      storyPoints: 8,
      estimateMinutes: 90,
    });

    // An explicit null clears one while leaving the other untouched (sparse).
    const cleared = await plansService.updateProposal(
      plan.id,
      itemId,
      { storyPoints: null },
      fx.ctx,
    );
    const pf = cleared.items.find((i) => i.id === itemId)!.proposedFields!;
    expect(pf.storyPoints).toBeNull();
    expect(pf.estimateMinutes).toBe(90); // untouched
  });

  it('addProposals rejects malformed sizing (negative points, non-integer minutes) — InvalidEstimateError', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Bad points', storyPoints: -1 } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidEstimateError);
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Bad minutes', estimateMinutes: 12.5 } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidEstimateError);
  });

  it('updateProposal rejects a patched-in bad estimate (InvalidEstimateError)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'OK', kind: 'subtask', storyPoints: 3 } }],
      fx.ctx,
    );
    const itemId = withItems.items[0]!.id;
    await plansService.markPlanned(plan.id, fx.ctx);
    await expect(
      plansService.updateProposal(plan.id, itemId, { estimateMinutes: -5 }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidEstimateError);
  });
});
