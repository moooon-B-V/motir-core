import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { APPROVED_SHAPE_VERDICT_MAX_IDS, plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { ApprovedShapeVerdictTooManyIdsError } from '@/lib/plans/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// THE APPROVED-SHAPE VERDICT (Story MOTIR-5544 · Subtask MOTIR-6225) over real
// Postgres — `plansService.resolveApprovedShapeVerdict`: is this card still what
// the last approved plan approved? Every plan is approved, declined and every
// card edited through the SHIPPED service paths; the revisions the verdict reads
// are the ones those paths really wrote.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Proposals = Parameters<typeof plansService.addProposals>[1];

/** A plan carrying `proposals`, driven through the real service to a decision. */
async function decidedPlan(
  fx: WorkItemFixture,
  proposals: Proposals,
  decision: 'approved' | 'declined' | 'planned',
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'A plan' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  if (decision === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else if (decision === 'declined') await plansService.declinePlan(plan.id, fx.ctx);
  // A plan left `planned` holds its targets; release them so a later plan in the
  // fixture may name the same card (see planHistoryRead.test.ts `freeTargets`).
  else await adminDb.planTargetLock.deleteMany({ where: { planId: plan.id } });
  return plan.id;
}

/** The `add` row titled `title` in `planId`, and the card it materialized. */
async function addOf(planId: string, title: string): Promise<{ proposalId: string; id: string }> {
  const rows = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  const row = rows.find((r) => (r.proposedFields as { title?: string } | null)?.title === title);
  if (!row?.workItemId) throw new Error(`no materialized add titled ${title} on ${planId}`);
  return { proposalId: row.id, id: row.workItemId };
}

const verdicts = (fx: WorkItemFixture, ids: string[], ctx: WorkspaceContext = fx.ctx) =>
  plansService.resolveApprovedShapeVerdict(fx.projectId, ids, ctx);

const one = async (fx: WorkItemFixture, id: string) => (await verdicts(fx, [id])).items[0]!;

/** A card created by an approved plan, with the plan and its decision. */
async function planBorn(fx: WorkItemFixture) {
  const planId = await decidedPlan(
    fx,
    [{ op: 'add', proposedFields: { title: 'Born', kind: 'task' } }],
    'approved',
  );
  const { proposalId, id } = await addOf(planId, 'Born');
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  return { planId, proposalId, id, decidedAt: plan.decidedAt! };
}

/** A status the card may legally move to from where it rests. */
async function legalNextStatus(id: string): Promise<string> {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return item.status === 'in_progress' ? 'todo' : 'in_progress';
}

describe('a leaf created by an approved plan', () => {
  it('untouched → unchanged, naming the plan, its decidedAt and the creating add', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);

    expect(await one(fx, born.id)).toEqual({
      workItemId: born.id,
      verdict: 'unchanged',
      planId: born.planId,
      planTitle: 'A plan',
      decidedAt: born.decidedAt.toISOString(),
      proposalId: born.proposalId,
      divergingRevision: null,
      childSet: null,
    });
  });

  it('after ONE real status transition → still unchanged, over the revision it wrote', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const to = await legalNextStatus(born.id);

    await workItemsService.updateStatus(born.id, to, fx.ctx);

    // The transition really wrote a status revision after the decision…
    const after = await adminDb.workItemRevision.findMany({
      where: { workItemId: born.id, changedAt: { gt: born.decidedAt } },
    });
    expect(after.map((r) => Object.keys(r.diff as object))).toEqual([['status']]);
    // …and the verdict read past it.
    expect(await one(fx, born.id)).toMatchObject({ verdict: 'unchanged', divergingRevision: null });
  });

  it('an assignee edit is ignored too', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    await workItemsService.updateWorkItem(born.id, { assigneeId: fx.ownerId }, fx.ctx);
    expect((await one(fx, born.id)).verdict).toBe('unchanged');
  });

  it('after a descriptionMd edit → changed, naming that revision', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    await workItemsService.updateStatus(born.id, await legalNextStatus(born.id), fx.ctx);
    await workItemsService.updateWorkItem(born.id, { descriptionMd: 'Rewritten.' }, fx.ctx);

    const after = await adminDb.workItemRevision.findMany({
      where: { workItemId: born.id, changedAt: { gt: born.decidedAt } },
    });
    const edit = after.find((r) => 'descriptionMd' in (r.diff as object))!;
    const v = await one(fx, born.id);
    expect(v.verdict).toBe('changed');
    expect(v.planId).toBe(born.planId);
    expect(v.divergingRevision).toMatchObject({
      id: edit.id,
      changedAt: edit.changedAt.toISOString(),
      changedById: fx.ownerId,
      changeKind: 'updated',
    });
    expect(v.divergingRevision!.changedKeys).toContain('descriptionMd');
  });

  it('two shape-changing revisions → the EARLIEST after decidedAt diverges', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    await workItemsService.updateWorkItem(born.id, { title: 'Renamed' }, fx.ctx);
    await workItemsService.updateWorkItem(born.id, { descriptionMd: 'Then rewritten.' }, fx.ctx);

    const rows = await adminDb.workItemRevision.findMany({
      where: { workItemId: born.id, changedAt: { gt: born.decidedAt } },
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(2);
    const v = await one(fx, born.id);
    expect(v.divergingRevision?.id).toBe(rows[0]!.id);
    expect(v.divergingRevision?.changedKeys).toEqual(['title']);
  });
});

describe('no_plan is a verdict, never an error', () => {
  it('a card no plan ever touched → no_plan, planId null', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Hand-made' },
      fx.ctx,
    );
    expect(await one(fx, card.id)).toEqual({
      workItemId: card.id,
      verdict: 'no_plan',
      planId: null,
      planTitle: null,
      decidedAt: null,
      proposalId: null,
      divergingRevision: null,
      childSet: null,
    });
  });

  it('a card whose only related plans are declined and planned → no_plan', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Hand-made' },
      fx.ctx,
    );
    await decidedPlan(
      fx,
      [{ op: 'modify', workItemId: card.id, patch: { title: 'X' } }],
      'declined',
    );
    await decidedPlan(
      fx,
      [{ op: 'modify', workItemId: card.id, patch: { title: 'Y' } }],
      'planned',
    );

    const history = await plansService.listPlanHistoryForWorkItem(
      fx.projectId,
      card.id,
      {},
      fx.ctx,
    );
    expect(history.items.map((e) => e.planStatus)).toEqual(['declined', 'planned']);
    expect(await one(fx, card.id)).toMatchObject({ verdict: 'no_plan', planId: null });
  });
});

describe('a container reads its child set', () => {
  /** A story and two subtasks, all born of ONE approved plan (temp-ref parents). */
  async function planBornStory(fx: WorkItemFixture) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Story plan' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Story', kind: 'story' } }],
      fx.ctx,
    );
    const storyAdd = first.items.find((i) => i.proposedFields?.title === 'Story')!;
    await plansService.addProposals(
      plan.id,
      ['One', 'Two'].map((title) => ({
        op: 'add' as const,
        proposedFields: { title, kind: 'subtask' as const },
        parentRef: `${TEMP_REF_PREFIX}${storyAdd.id}`,
      })),
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);
    return {
      planId: plan.id,
      story: await addOf(plan.id, 'Story'),
      one: await addOf(plan.id, 'One'),
      two: await addOf(plan.id, 'Two'),
    };
  }

  it('answers per id — the container and each supplied child — in the order supplied', async () => {
    const fx = await makeWorkItemFixture();
    const t = await planBornStory(fx);

    const page = await verdicts(fx, [t.two.id, t.story.id, t.one.id]);
    expect(page.items.map((v) => [v.workItemId, v.verdict, v.proposalId])).toEqual([
      [t.two.id, 'unchanged', t.two.proposalId],
      [t.story.id, 'unchanged', t.story.proposalId],
      [t.one.id, 'unchanged', t.one.proposalId],
    ]);
    expect(page.items[1]!.childSet).toEqual({
      verdict: 'unchanged',
      approvedChildIds: [t.one.id, t.two.id].sort(),
      currentChildIds: [t.one.id, t.two.id].sort(),
      added: [],
      removed: [],
    });
    expect(page.items[0]!.childSet).toBeNull();
  });

  it('a child added outside the plan → the container is changed, with no diverging revision', async () => {
    const fx = await makeWorkItemFixture();
    const t = await planBornStory(fx);
    const extra = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Extra', parentId: t.story.id },
      fx.ctx,
    );

    const v = await one(fx, t.story.id);
    expect(v.verdict).toBe('changed');
    expect(v.divergingRevision).toBeNull();
    expect(v.childSet).toMatchObject({ verdict: 'changed', added: [extra.id], removed: [] });
  });

  it('an approved child archived → the container is changed, the child removed', async () => {
    const fx = await makeWorkItemFixture();
    const t = await planBornStory(fx);
    await workItemsService.archiveWorkItem(t.two.id, fx.ctx);

    const [story, two] = (await verdicts(fx, [t.story.id, t.two.id])).items;
    expect(story).toMatchObject({
      verdict: 'changed',
      childSet: { removed: [t.two.id], added: [] },
    });
    // The child's own log carries the archive, and an archive is a departure.
    expect(two).toMatchObject({
      verdict: 'changed',
      divergingRevision: { changeKind: 'archived' },
    });
  });

  it('a plan that only ADDS a child to an existing container approved the children it had', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Hand-made story' },
      fx.ctx,
    );
    const old = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Old', parentId: story.id },
      fx.ctx,
    );
    const planId = await decidedPlan(
      fx,
      [{ op: 'add', proposedFields: { title: 'New', kind: 'subtask' }, parentRef: story.id }],
      'approved',
    );
    const added = await addOf(planId, 'New');

    const v = await one(fx, story.id);
    expect(v).toMatchObject({ verdict: 'unchanged', planId, proposalId: null });
    expect(v.childSet?.approvedChildIds).toEqual([old.id, added.id].sort());
  });
});

describe('the gate and the bound', () => {
  it('asserts ai:view_plan — a viewer gets the error the history read raises', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const user = await createTestUser({ name: 'Viewer' });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role: 'viewer',
    });
    const viewer = { userId: user.id, workspaceId: fx.workspaceId };

    await expect(
      plansService.listPlanHistoryForWorkItem(fx.projectId, born.id, {}, viewer),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(verdicts(fx, [born.id], viewer)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(verdicts(fx, [], viewer)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses more ids than one read answers, rather than truncating', async () => {
    const fx = await makeWorkItemFixture();
    const ids = Array.from({ length: APPROVED_SHAPE_VERDICT_MAX_IDS + 1 }, (_, i) => `id-${i}`);
    await expect(verdicts(fx, ids)).rejects.toBeInstanceOf(ApprovedShapeVerdictTooManyIdsError);
  });
});
