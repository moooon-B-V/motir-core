import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import * as plansModule from '@/lib/services/plansService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { PlanGrammarError, PlanRefGraphError, PlanTargetImmutableError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 7.12.5 / MOTIR-911 — the CONFIRMATION GATE at the persist boundary,
// against real Postgres (no mocks, per CLAUDE.md).
//
// `tests/plans/validateProposals.test.ts` pins the VERDICT as pure logic. What
// only a real database can prove — and what this file proves — is the other
// half of the contract:
//   • a rejection leaves the tree BYTE-IDENTICAL (no work item created, no
//     target touched, the plan still `planned` and re-approvable);
//   • the immutability verdict is re-taken UNDER THE ROW LOCK, so a transition
//     that commits after the pre-transaction read still blocks the write
//     (`notes.html` #35 — a pre-transaction snapshot goes stale);
//   • a valid approve still materializes exactly as before;
//   • the gate is UNCONDITIONAL — no flag, setting or trigger reaches
//     materialize around it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Seed a work item through the real service (valid fractional position/rank). */
async function seedItem(
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask' = 'task',
  parentId?: string,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

/** Walk an item to `done` along the legal workflow path (no direct edge). */
async function markDone(fx: WorkItemFixture, id: string): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(id, 'in_review', fx.ctx);
  await workItemsService.updateStatus(id, 'done', fx.ctx);
}

/** Create a plan, append the proposals, and mark it `planned`. */
async function plannedPlan(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
  opts: { sourceJobId?: string } = {},
): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Proposed', ...(opts.sourceJobId ? { sourceJobId: opts.sourceJobId } : {}) },
    fx.ctx,
  );
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** A snapshot of everything an approve could touch, for a byte-identical check. */
async function treeSnapshot(fx: WorkItemFixture): Promise<unknown> {
  const items = await db.workItem.findMany({
    where: { projectId: fx.projectId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      kind: true,
      parentId: true,
      status: true,
      descriptionMd: true,
      priority: true,
      archivedAt: true,
      updatedAt: true,
    },
  });
  const links = await db.workItemLink.findMany({
    where: { workspaceId: fx.workspaceId },
    orderBy: { id: 'asc' },
    select: { fromId: true, toId: true, kind: true },
  });
  const revisions = await db.workItemRevision.count({
    where: { workItem: { projectId: fx.projectId } },
  });
  return { items, links, revisions };
}

/**
 * Approve and assert it was REJECTED with `expected`, leaving everything
 * untouched: the tree byte-identical, the plan still `planned` (so the user can
 * fix the proposal and approve again), and no PlanItem written back an id.
 */
async function expectRejectedWithNoWrite(
  fx: WorkItemFixture,
  planId: string,
  expected: new (...args: never[]) => Error,
): Promise<Error> {
  const before = await treeSnapshot(fx);

  let thrown: Error | undefined;
  try {
    await plansService.approvePlan(planId, fx.ctx);
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown, 'the approve must be rejected').toBeInstanceOf(expected);
  expect(await treeSnapshot(fx)).toEqual(before);

  const plan = await plansService.getPlan(planId, fx.ctx);
  expect(plan.status).toBe('planned');
  expect(plan.items.filter((i) => i.op === 'add').every((i) => i.workItemId === null)).toBe(true);
  return thrown!;
}

describe('the confirmation gate — kind-parent grammar, re-validated at persist', () => {
  it('rejects an add whose REAL parent may not hold it, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const epicId = await seedItem(fx, 'The epic', 'epic');
    // A subtask may NOT hang off an epic (`lib/issues/parentRules.ts`). Before
    // this gate the only backstop was the DB trigger — a raw SQLSTATE 23514
    // surfacing as a 500, mid-transaction.
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Illegal child', kind: 'subtask' }, parentRef: epicId },
    ]);

    const err = await expectRejectedWithNoWrite(fx, planId, PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('illegal_parent');
    expect(await db.workItem.count({ where: { title: 'Illegal child' } })).toBe(0);
  });

  it('rejects an add whose INTRA-PLAN parent may not hold it', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A bug', kind: 'bug' } }],
      fx.ctx,
    );
    const bugRef = `${TEMP_REF_PREFIX}${withItems.items[0]!.id}`;
    // A bug may parent ONLY subtasks — a story under it is illegal.
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' }, parentRef: bugRef }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    await expectRejectedWithNoWrite(fx, plan.id, PlanGrammarError);
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('rejects a top-level subtask (a kind that requires a parent)', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Orphan', kind: 'subtask' } },
    ]);
    await expectRejectedWithNoWrite(fx, planId, PlanGrammarError);
  });

  it('rejects a human EDIT that breaks the grammar after generation (the proposal is not trusted)', async () => {
    const fx = await makeWorkItemFixture();
    const bugId = await seedItem(fx, 'A bug', 'bug');
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    // Generated legally: a subtask under a bug.
    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Fix it', kind: 'subtask' }, parentRef: bugId }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    // …then the reviewer re-kinds it to a story, which a bug may NOT parent.
    // The planner's own check ran BEFORE this edit, which is exactly why the
    // gate re-validates independently at persist.
    await plansService.updateProposal(plan.id, withItems.items[0]!.id, { kind: 'story' }, fx.ctx);

    await expectRejectedWithNoWrite(fx, plan.id, PlanGrammarError);
  });
});

describe('the confirmation gate — the intra-plan ref graph', () => {
  it('rejects a dangling parentRef, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Hangs off nothing', kind: 'task' },
        parentRef: `${TEMP_REF_PREFIX}nope`,
      },
    ]);
    const err = await expectRejectedWithNoWrite(fx, planId, PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('dangling');
  });

  it('rejects a parentRef naming a work item outside the workspace', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreignId = await seedItem(other, 'Foreign parent', 'story');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Cross-tenant', kind: 'task' }, parentRef: foreignId },
    ]);
    await expectRejectedWithNoWrite(fx, planId, PlanRefGraphError);
  });

  it('rejects a duplicated blocker (the is_blocked_by edge is unique) before it 500s', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'The blocker');
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Blocked twice', kind: 'task' },
        blockedByRefs: [blockerId, blockerId],
      },
    ]);
    const err = await expectRejectedWithNoWrite(fx, planId, PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('duplicate');
  });

  it('rejects a parentRef CYCLE, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A', kind: 'story' } }],
      fx.ctx,
    );
    const second = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'B', kind: 'story' },
          parentRef: `${TEMP_REF_PREFIX}${first.items[0]!.id}`,
        },
      ],
      fx.ctx,
    );
    const bId = second.items.find((i) => i.proposedFields?.title === 'B')!.id;
    // Close the loop: A's parent is B, B's parent is A.
    await db.planItem.update({
      where: { id: first.items[0]!.id },
      data: { parentRef: `${TEMP_REF_PREFIX}${bId}` },
    });
    await plansService.markPlanned(plan.id, fx.ctx);

    const err = await expectRejectedWithNoWrite(fx, plan.id, PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('cycle');
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('materializes a valid set parent-before-child regardless of proposal ORDER', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, {}, fx.ctx);
    // Append the CHILD's proposal first; only the ref graph imposes an order.
    const epic = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Root epic', kind: 'epic' } }],
      fx.ctx,
    );
    const epicRef = `${TEMP_REF_PREFIX}${epic.items[0]!.id}`;
    const story = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Mid story', kind: 'story' }, parentRef: epicRef }],
      fx.ctx,
    );
    const storyId = story.items.find((i) => i.proposedFields?.title === 'Mid story')!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Leaf subtask', kind: 'subtask' },
          parentRef: `${TEMP_REF_PREFIX}${storyId}`,
        },
      ],
      fx.ctx,
    );
    // Reverse the stored read order (findByPlan is createdAt asc) so the LEAF is
    // read first and the root last — materialize must still create parent-first.
    const stored = await db.planItem.findMany({
      where: { planId: plan.id },
      orderBy: { createdAt: 'asc' },
    });
    for (const [i, item] of [...stored].reverse().entries()) {
      await db.planItem.update({
        where: { id: item.id },
        data: { createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)) },
      });
    }
    await plansService.markPlanned(plan.id, fx.ctx);

    const approved = await plansService.approvePlan(plan.id, fx.ctx);
    expect(approved.status).toBe('approved');

    const rows = await db.workItem.findMany({ where: { projectId: fx.projectId } });
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(rows).toHaveLength(3);
    expect(byTitle.get('Root epic')!.parentId).toBeNull();
    expect(byTitle.get('Mid story')!.parentId).toBe(byTitle.get('Root epic')!.id);
    expect(byTitle.get('Leaf subtask')!.parentId).toBe(byTitle.get('Mid story')!.id);
  });
});

describe('the confirmation gate — done-work immutability', () => {
  it('rejects a modify of a DONE work item, leaving the target untouched', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Shipped work');
    await markDone(fx, targetId);
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'Rewritten' } },
    ]);

    const err = await expectRejectedWithNoWrite(fx, planId, PlanTargetImmutableError);
    expect((err as PlanTargetImmutableError).workItemId).toBe(targetId);
    const target = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.title).toBe('Shipped work');
    expect(target.status).toBe('done');
  });

  it('rejects a remove of a CANCELLED item — terminal is the `done` CATEGORY, not the key', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Dropped work');
    await workItemsService.updateStatus(targetId, 'cancelled', fx.ctx);
    const planId = await plannedPlan(fx, [{ op: 'remove', workItemId: targetId }]);

    const err = await expectRejectedWithNoWrite(fx, planId, PlanTargetImmutableError);
    expect((err as PlanTargetImmutableError).status).toBe('cancelled');
    const target = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.archivedAt).toBeNull();
  });

  it('allows a modify of work still in flight', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'In flight');
    await workItemsService.updateStatus(targetId, 'in_progress', fx.ctx);
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'Re-scoped' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const target = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.title).toBe('Re-scoped');
  });

  it('re-takes the verdict UNDER THE ROW LOCK — a transition committing after the pre-transaction read still blocks the write', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Racing target');
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'Should never land' } },
    ]);

    // A concurrent transition to `done`, held UNCOMMITTED. Under MVCC the
    // approve's pre-transaction read is GUARANTEED to still see the old status
    // (an uncommitted write is invisible), so this test can only pass through
    // the LOCKED in-transaction re-read — which is exactly what `notes.html` #35
    // requires and what a pre-transaction snapshot alone would miss.
    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });

    const transition = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "work_item" SET "status" = 'done' WHERE "id" = ${targetId}`;
        lockTaken();
        // Hold the lock long enough for the approve to pass its pre-transaction
        // gate and BLOCK on `lockById`, then commit and release it.
        await new Promise((resolve) => setTimeout(resolve, 750));
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    await locked;
    const approving = plansService.approvePlan(planId, fx.ctx).catch((err: unknown) => err);
    await transition;
    const outcome = await approving;

    expect(outcome).toBeInstanceOf(PlanTargetImmutableError);
    const target = await db.workItem.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.title).toBe('Racing target');
    expect(target.status).toBe('done');
    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.status).toBe('planned');
  });
});

describe('the confirmation gate — unconditional, and non-regressive', () => {
  it('a valid approve still materializes exactly as before (adds, edges, revisions)', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'Existing blocker');
    const storyId = await seedItem(fx, 'Existing story', 'story');
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'New subtask', kind: 'subtask', storyPoints: 3 },
        parentRef: storyId,
        blockedByRefs: [blockerId],
      },
      { op: 'modify', workItemId: blockerId, patch: { title: 'Existing blocker (renamed)' } },
    ]);

    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');

    const created = await db.workItem.findFirstOrThrow({ where: { title: 'New subtask' } });
    expect(created.parentId).toBe(storyId);
    expect(Number(created.storyPoints)).toBe(3);
    // The written-back id is on the PlanItem, and the blocked-by edge exists.
    expect(approved.items.find((i) => i.op === 'add')!.workItemId).toBe(created.id);
    const link = await db.workItemLink.findFirstOrThrow({
      where: { fromId: created.id, toId: blockerId, kind: 'is_blocked_by' },
    });
    expect(link.toId).toBe(blockerId);
    const renamed = await db.workItem.findUniqueOrThrow({ where: { id: blockerId } });
    expect(renamed.title).toBe('Existing blocker (renamed)');
    expect(
      await db.workItemRevision.count({ where: { workItemId: created.id, changeKind: 'created' } }),
    ).toBe(1);
  });

  it('an empty plan stays a valid no-op that writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, []);
    const before = await treeSnapshot(fx);

    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');
    expect(await treeSnapshot(fx)).toEqual(before);
  });

  it('applies identically however the plan was TRIGGERED — a cadence job and a user turn', async () => {
    const fx = await makeWorkItemFixture();
    const epicId = await seedItem(fx, 'The epic', 'epic');
    const illegal = {
      op: 'add' as const,
      proposedFields: { title: 'Illegal child', kind: 'subtask' },
      parentRef: epicId,
    };
    // The cadence watcher / `/ready` nudge stamps a sourceJobId; a user turn
    // does not. The gate lives on the ONE persist path, so the trigger is
    // irrelevant by construction — assert it.
    const fromCadence = await plannedPlan(fx, [illegal], { sourceJobId: 'job_cadence_1' });
    const fromUser = await plannedPlan(fx, [illegal]);

    await expectRejectedWithNoWrite(fx, fromCadence, PlanGrammarError);
    await expectRejectedWithNoWrite(fx, fromUser, PlanGrammarError);
  });

  it('exposes NO bypass — approve is the only path from a proposal to a row', async () => {
    // `materialize` is module-private and no "force"/"skip"/"unsafe" variant is
    // exported: there is no endpoint, flag or setting that writes proposals
    // without the gate.
    expect(Object.keys(plansModule)).not.toContain('materialize');
    const bypass = Object.keys(plansService).filter((k) =>
      /materialize|force|unsafe|skip|bypass|unchecked/i.test(k),
    );
    expect(bypass).toEqual([]);

    // And the only status-mutating path that writes work items is approvePlan:
    // decline drops the proposals with the tree untouched.
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Never built', kind: 'task' } },
    ]);
    await plansService.declinePlan(planId, fx.ctx);
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});
