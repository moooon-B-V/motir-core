import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { InvalidProposalError, PlanGrammarError } from '@/lib/plans/errors';
import type { PlanItemPatch } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-8192 — a plan `modify` could not change a committed card's KIND.
//
// ── The reproduction ───────────────────────────────────────────────────────
// `PLAN_ITEM_PATCH_KEYS` had no `kind`, so an append carrying
// `{ op: 'modify', patch: { kind: 'story' } }` was refused by
// `assertKnownPatchKeys` with INVALID_PROPOSAL, and the only way to turn a task
// into a story was `change_kind`, outside the plan a person approves. The first
// test below is that append, now accepted and carried all the way to the row.
//
// ── What is pinned here, against real Postgres ─────────────────────────────
// A: the re-kind is judged at the APPEND and again at APPROVE against the
//    projected tree, shown on the review, and written with its children, its
//    links and its history intact. The container leaf-field rule REFUSES
//    (AMENDMENT 25 §3) — the executor, which no patch key reaches, is derived.
// B: an `add`'s kind correction is held to the same rules.

async function create(
  fx: WorkItemFixture,
  input: Parameters<typeof workItemsService.createWorkItem>[0] extends infer T
    ? Omit<T, 'projectId'>
    : never,
): Promise<string> {
  return (await workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx)).id;
}

/** An epic holding a typed, judged task with two subtask children. */
async function taskWithSubtasks(fx: WorkItemFixture) {
  const epic = await create(fx, { kind: 'epic', title: 'Checkout' });
  const task = await create(fx, {
    kind: 'task',
    title: 'Payment step',
    parentId: epic,
    type: 'code',
    difficulty: 'medium',
  });
  const s1 = await create(fx, { kind: 'subtask', title: 'Card form', parentId: task });
  const s2 = await create(fx, { kind: 'subtask', title: 'Receipt', parentId: task });
  return { epic, task, s1, s2 };
}

async function openPlan(fx: WorkItemFixture) {
  return plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
}

async function plannedModify(fx: WorkItemFixture, workItemId: string, patch: PlanItemPatch) {
  const plan = await openPlan(fx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('A — a `modify` re-kinds a committed work item', () => {
  it('a task with subtask children becomes a story, shown on review and written with children, links and history intact', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, task, s1, s2 } = await taskWithSubtasks(fx);
    const other = await create(fx, { kind: 'task', title: 'Fraud check', parentId: epic });
    await workItemsService.linkWorkItems({ fromId: task, toId: other, kind: 'relates_to' }, fx.ctx);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: task } });
    expect(before.executor).toBe('coding_agent');

    const planId = await plannedModify(fx, task, { kind: 'story', type: null, difficulty: null });

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const item = review.items.find((i) => i.op === 'modify')!;
    expect(item.changes).toContainEqual({ field: 'kind', from: 'task', to: 'story' });
    expect(item.changes).toContainEqual({ field: 'type', from: 'code', to: null });
    expect(item.changes).toContainEqual({ field: 'difficulty', from: 'medium', to: null });
    // The DERIVED executor row — no patch key produces it.
    expect(item.changes).toContainEqual({ field: 'executor', from: 'coding_agent', to: null });

    await plansService.approvePlan(planId, fx.ctx);

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: task } });
    expect(after).toMatchObject({
      kind: 'story',
      type: null,
      executor: null,
      difficulty: null,
      parentId: epic,
      identifier: before.identifier,
    });
    const children = await adminDb.workItem.findMany({
      where: { parentId: task },
      select: { id: true },
    });
    expect(children.map((c) => c.id).sort()).toEqual([s1, s2].sort());
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: task, toId: other, kind: 'relates_to' },
      }),
    ).toBe(1);

    const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId: task } });
    expect(revisions.some((r) => r.changeKind === 'created')).toBe(true);
    const rekind = revisions.find(
      (r) => r.changeKind === 'updated' && (r.diff as Record<string, unknown>).kind !== undefined,
    );
    expect((rekind!.diff as Record<string, unknown>).kind).toEqual({ from: 'task', to: 'story' });
    expect((rekind!.diff as Record<string, unknown>).executor).toEqual({
      from: 'coding_agent',
      to: null,
    });
  });

  it('refuses `epic` at the append, by name, and stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { task } = await taskWithSubtasks(fx);
    const plan = await openPlan(fx);
    const err = await refusal(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: task, patch: { kind: 'epic' as never } }],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect(err.message).toContain('`epic`');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('refuses at the append a kind that cannot parent a child the target keeps', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await create(fx, { kind: 'epic', title: 'Checkout' });
    const story = await create(fx, { kind: 'story', title: 'Pay', parentId: epic });
    await create(fx, { kind: 'task', title: 'Card form', parentId: story });
    const plan = await openPlan(fx);
    const err = await refusal(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: story, patch: { kind: 'task' } }],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    expect(err.message).toContain('Card form');
  });

  it('refuses at the append a container that keeps the target’s type, by name', async () => {
    const fx = await makeWorkItemFixture();
    const { task } = await taskWithSubtasks(fx);
    const plan = await openPlan(fx);
    const err = await refusal(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: task, patch: { kind: 'story', difficulty: null } }],
        fx.ctx,
      ),
    );
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('type_on_container');
  });

  it('re-asks at APPROVE: a child added after the close refuses the re-kind, and nothing moves', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await create(fx, { kind: 'epic', title: 'Checkout' });
    const target = await create(fx, { kind: 'task', title: 'Payment step', parentId: epic });
    const planId = await plannedModify(fx, target, { kind: 'bug' });
    // A bug parents only subtasks; a bug child arriving now makes the re-kind illegal.
    await create(fx, { kind: 'bug', title: 'Double charge', parentId: target });

    const err = await refusal(plansService.approvePlan(planId, fx.ctx));
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: target } })).kind).toBe('task');
  });
});

describe('B — an `add`’s kind correction is held to the same rules', () => {
  async function planWithAdds(fx: WorkItemFixture) {
    const epic = await create(fx, { kind: 'epic', title: 'Checkout' });
    const story = await create(fx, { kind: 'story', title: 'Pay', parentId: epic });
    const plan = await openPlan(fx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: story,
          proposedFields: { kind: 'task', title: 'Card form', type: 'code' },
        },
      ],
      fx.ctx,
    );
    const taskAdd = appended.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${taskAdd}`,
          proposedFields: { kind: 'subtask', title: 'Validate the number' },
        },
      ],
      fx.ctx,
    );
    return { planId: plan.id, taskAdd };
  }

  it('refuses a container that keeps its leaf fields, then a kind its parent refuses', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, taskAdd } = await planWithAdds(fx);

    const kept = await refusal(
      plansService.correctProposal(planId, taskAdd, { kind: 'story' }, fx.ctx),
    );
    expect(kept).toBeInstanceOf(InvalidProposalError);
    expect(kept.message).toContain('`type`');

    // Cleared, a story still cannot sit under a story.
    const placed = await refusal(
      plansService.correctProposal(planId, taskAdd, { kind: 'story', type: null }, fx.ctx),
    );
    expect(placed).toBeInstanceOf(PlanGrammarError);
    expect((placed as PlanGrammarError).reason).toBe('illegal_parent');
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: taskAdd } });
    expect((row.proposedFields as { kind?: string }).kind).toBe('task');
  });

  it('refuses a kind that cannot parent the proposal hung under it, and accepts a legal one', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, taskAdd } = await planWithAdds(fx);

    const err = await refusal(
      plansService.correctProposal(planId, taskAdd, { kind: 'subtask', type: null }, fx.ctx),
    );
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect(err.message).toContain('Validate the number');

    await plansService.correctProposal(planId, taskAdd, { kind: 'bug' }, fx.ctx);
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: taskAdd } });
    expect((row.proposedFields as { kind?: string }).kind).toBe('bug');
  });
});
