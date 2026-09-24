import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { InvalidProposalError, PlanGrammarError } from '@/lib/plans/errors';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A plan proposal CARRIES a leaf's difficulty (Story MOTIR-6095 · MOTIR-6133;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 19).
//
// The value rides the `storyPoints` route on every op and every door — an
// `add`'s `proposedFields`, a `modify`'s `patch`, the deepen and the correction
// — and approve writes it onto the work item. Approve does NOT go through
// `workItemsService`, so the container refusal 6016 ships there never runs on
// this path; the plan path's own refusal is what these cases pin, at append,
// deepen, correct and approve.
//
// Real Postgres, per CLAUDE.md: what is asserted is what lands in `plan_item`,
// `work_item` and `work_item_revision`, and that a refusal leaves them untouched.
// That every door reaches the ONE shared validator (rather than a copy) is
// pinned structurally in `tests/plans/validateProposedDifficulty.test.ts`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function newPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx)).id;
}

async function appendAdd(
  fx: WorkItemFixture,
  planId: string,
  proposedFields: PlanItemProposedFields,
): Promise<string> {
  const res = await plansService.addProposals(planId, [{ op: 'add', proposedFields }], fx.ctx);
  return res.appendedItemIds[0]!;
}

async function proposedFieldsOf(planItemId: string): Promise<Record<string, unknown>> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: planItemId } });
  return row.proposedFields as Record<string, unknown>;
}

async function planItemCount(planId: string): Promise<number> {
  return adminDb.planItem.count({ where: { planId } });
}

describe('append — an `add` carries a difficulty (MOTIR-6133)', () => {
  it('persists every member of the scale on every leaf kind', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    for (const kind of ['subtask', 'task', 'bug']) {
      for (const difficulty of WORK_ITEM_DIFFICULTIES) {
        const id = await appendAdd(fx, planId, {
          title: `${kind}-${difficulty}`,
          kind,
          difficulty,
        });
        expect(await proposedFieldsOf(id)).toMatchObject({ kind, difficulty });
      }
    }
  });

  it('persists NO key when the add carries none', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const id = await appendAdd(fx, planId, { title: 'Unjudged', kind: 'task' });
    expect(await proposedFieldsOf(id)).not.toHaveProperty('difficulty');
  });

  it('refuses a container kind with a non-null difficulty, naming the field and the kind, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    for (const kind of ['epic', 'story']) {
      const err = await plansService
        .addProposals(
          planId,
          [{ op: 'add', proposedFields: { title: `A ${kind}`, kind, difficulty: 'low' } }],
          fx.ctx,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidProposalError);
      expect((err as Error).message).toContain('difficulty');
      expect((err as Error).message).toContain(kind);
    }
    expect(await planItemCount(planId)).toBe(0);
  });

  it('judges an add with NO kind on the kind materialize defaults to (`task`, a leaf)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const id = await appendAdd(fx, planId, { title: 'Default kind', difficulty: 'high' });
    expect(await proposedFieldsOf(id)).toMatchObject({ difficulty: 'high' });
  });

  it('refuses a value outside the four members', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const err = await plansService
      .addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: {
              title: 'Bad',
              kind: 'task',
              difficulty: 'extreme' as unknown as 'high',
            },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('extreme');
    expect(await planItemCount(planId)).toBe(0);
  });
});

describe('append — a `modify` patch carries a difficulty (MOTIR-6133)', () => {
  it('refuses a non-null patch.difficulty on an epic or story target, and accepts `null` there', async () => {
    const fx = await makeWorkItemFixture();
    for (const kind of ['epic', 'story'] as const) {
      const target = await createTestWorkItem(fx, { kind, title: `The ${kind}` });
      const planId = await newPlan(fx);
      const err = await plansService
        .addProposals(
          planId,
          [{ op: 'modify', workItemId: target.id, patch: { difficulty: 'medium' } }],
          fx.ctx,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidProposalError);
      expect((err as Error).message).toContain('difficulty');
      expect((err as Error).message).toContain(kind);
      expect(await planItemCount(planId)).toBe(0);

      const cleared = await plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: target.id, patch: { difficulty: null } }],
        fx.ctx,
      );
      const row = await adminDb.planItem.findUniqueOrThrow({
        where: { id: cleared.appendedItemIds[0]! },
      });
      expect(row.patch).toEqual({ difficulty: null });
    }
  });

  it('a second modify of one card MERGES its difficulty like storyPoints — later wins, null clears', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await newPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { difficulty: 'low', storyPoints: 3 } }],
      fx.ctx,
    );
    const rowId = first.appendedItemIds[0]!;
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { difficulty: 'high' } }],
      fx.ctx,
    );
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: rowId } })).patch).toEqual({
      difficulty: 'high',
      storyPoints: 3,
    });
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { difficulty: null } }],
      fx.ctx,
    );
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: rowId } })).patch).toEqual({
      difficulty: null,
      storyPoints: 3,
    });
    expect(await planItemCount(planId)).toBe(1);
  });
});

describe('deepen and correct — judged on the MERGED result (MOTIR-6133)', () => {
  it('a deepen that turns an add carrying a difficulty into a story is refused; clearing in the same patch succeeds', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const id = await appendAdd(fx, planId, { title: 'Leaf', kind: 'task', difficulty: 'medium' });

    const err = await plansService
      .deepenProposal(planId, id, { kind: 'story' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('difficulty');
    expect((err as Error).message).toContain('story');
    expect(await proposedFieldsOf(id)).toMatchObject({ kind: 'task', difficulty: 'medium' });

    await plansService.deepenProposal(planId, id, { kind: 'story', difficulty: null }, fx.ctx);
    expect(await proposedFieldsOf(id)).toMatchObject({ kind: 'story', difficulty: null });
  });

  it('a deepen may set and change the difficulty on a leaf', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const id = await appendAdd(fx, planId, { title: 'Leaf', kind: 'subtask' });
    await plansService.deepenProposal(planId, id, { difficulty: 'trivial' }, fx.ctx);
    expect(await proposedFieldsOf(id)).toMatchObject({ difficulty: 'trivial' });
  });

  it('correctProposal refuses the same kind flip on an add, and accepts it with the clear', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const id = await appendAdd(fx, planId, { title: 'Leaf', kind: 'task', difficulty: 'low' });

    const err = await plansService
      .correctProposal(planId, id, { kind: 'epic' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('epic');
    expect(await proposedFieldsOf(id)).toMatchObject({ kind: 'task', difficulty: 'low' });

    await plansService.correctProposal(planId, id, { kind: 'epic', difficulty: null }, fx.ctx);
    expect(await proposedFieldsOf(id)).toMatchObject({ kind: 'epic', difficulty: null });
  });

  it("correctProposal judges a modify's replacement patch against the TARGET's kind", async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Container' });
    const planId = await newPlan(fx);
    const added = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: story.id, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    const id = added.appendedItemIds[0]!;

    const err = await plansService
      .correctProposal(planId, id, { patch: { title: 'Renamed', difficulty: 'high' } }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('story');
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id } })).patch).toEqual({
      title: 'Renamed',
    });

    const badMember = await plansService
      .correctProposal(planId, id, { patch: { difficulty: 'nope' as unknown as 'high' } }, fx.ctx)
      .catch((e: unknown) => e);
    expect(badMember).toBeInstanceOf(InvalidProposalError);

    await plansService.correctProposal(planId, id, { patch: { difficulty: null } }, fx.ctx);
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id } })).patch).toEqual({
      difficulty: null,
    });
  });
});

describe('approve — writes the difficulty onto the work item (MOTIR-6133)', () => {
  it("writes each add's difficulty, NULL when absent, and records it in the created revision", async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [
        { op: 'add', proposedFields: { title: 'Judged', kind: 'task', difficulty: 'medium' } },
        { op: 'add', proposedFields: { title: 'Unjudged', kind: 'task' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const judged = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Judged' },
    });
    const unjudged = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Unjudged' },
    });
    expect(judged.difficulty).toBe('medium');
    expect(unjudged.difficulty).toBeNull();

    const created = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: judged.id, changeKind: 'created' },
    });
    expect(created.diff).toMatchObject({ difficulty: { from: null, to: 'medium' } });
  });

  it("writes a modify's patch.difficulty with ONE revision whose diff is { from: 'medium', to: 'high' }", async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    await adminDb.workItem.update({ where: { id: target.id }, data: { difficulty: 'medium' } });
    const before = await adminDb.workItemRevision.count({ where: { workItemId: target.id } });

    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { difficulty: 'high' } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } })).difficulty,
    ).toBe('high');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: target.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(revisions).toHaveLength(before + 1);
    expect(revisions.at(-1)!.diff).toEqual({ difficulty: { from: 'medium', to: 'high' } });
  });

  it('refuses at approve with difficulty_on_container when the target was re-kinded after the append, and materializes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf, for now' });
    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [
        { op: 'add', proposedFields: { title: 'A sibling card', kind: 'task' } },
        { op: 'modify', workItemId: target.id, patch: { difficulty: 'high' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    // The world moves between the close and the button: the leaf becomes a story.
    await adminDb.workItem.update({ where: { id: target.id }, data: { kind: 'story' } });

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('difficulty_on_container');

    expect(
      await adminDb.workItem.count({ where: { projectId: fx.projectId, title: 'A sibling card' } }),
    ).toBe(0);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.difficulty).toBeNull();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
  });
});
