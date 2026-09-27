import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { InvalidProposalError, PlanTargetImmutableError } from '@/lib/plans/errors';
import type { PlanItemPatch } from '@/lib/dto/plans';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A plan `modify` CARRIES the obsolescence mark and its note (Story MOTIR-6577 ·
// MOTIR-6629) — the columns MOTIR-6574 shipped, reachable from a plan at last.
//
// The pair rides the `modify` patch like every scalar: validated at the append
// and the correction (`INVALID_PROPOSAL` naming the field), merged later-wins on
// a second `modify`, and written by approve onto the target with the same
// revision cells the direct door records. And the one thing no other patch key
// may do: a MARK-ONLY `modify` reaches a `done` / `cancelled` target, whose
// status, branch and parent approve then leave alone — while any other key on a
// finished card is still `PLAN_TARGET_IMMUTABLE`.
//
// Real Postgres, per CLAUDE.md: what is asserted is what lands in `plan_item`,
// `work_item` and `work_item_revision`, and that a refusal leaves them untouched.

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

async function modifyPlan(
  fx: WorkItemFixture,
  workItemId: string,
  patch: PlanItemPatch,
): Promise<string> {
  const planId = await newPlan(fx);
  await plansService.addProposals(planId, [{ op: 'modify', workItemId, patch }], fx.ctx);
  return planId;
}

async function closeAndApprove(fx: WorkItemFixture, planId: string): Promise<void> {
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
}

/** The refusal a plan gets on its way to approve — at the close or at the button. */
async function refusalOnTheWay(fx: WorkItemFixture, planId: string): Promise<unknown> {
  return plansService
    .markPlanned(planId, fx.ctx)
    .then(() => plansService.approvePlan(planId, fx.ctx))
    .then(() => null)
    .catch((e: unknown) => e);
}

const row = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

/** The revisions of `workItemId` that carry an `obsolescence` cell. */
async function markRevisions(workItemId: string) {
  const all = await adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
  });
  return all.filter((r) => Object.prototype.hasOwnProperty.call(r.diff, 'obsolescence'));
}

describe('append — a `modify` patch carries the mark (MOTIR-6629)', () => {
  it('persists both keys, and an explicit `null` for each', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await newPlan(fx);
    const set = await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { obsolescence: 'outdated', obsolescenceNoteMd: 'The flow moved.' },
        },
      ],
      fx.ctx,
    );
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: set.appendedItemIds[0]! } })).patch,
    ).toEqual({ obsolescence: 'outdated', obsolescenceNoteMd: 'The flow moved.' });

    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Container' });
    const cleared = await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: other.id,
          patch: { obsolescence: null, obsolescenceNoteMd: null },
        },
      ],
      fx.ctx,
    );
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: cleared.appendedItemIds[0]! } }))
        .patch,
    ).toEqual({ obsolescence: null, obsolescenceNoteMd: null });
  });

  it('refuses a mark outside `outdated` · `deprecated` · null as INVALID_PROPOSAL naming the field, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await newPlan(fx);
    const err = await plansService
      .addProposals(
        planId,
        [
          {
            op: 'modify',
            workItemId: target.id,
            patch: { obsolescence: 'obsolete' as unknown as 'outdated' },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as InvalidProposalError).code).toBe('INVALID_PROPOSAL');
    expect((err as Error).message).toContain('`obsolescence`');
    expect((err as Error).message).toContain('obsolete');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });

  it('refuses a note that is not a string, naming the field', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await newPlan(fx);
    const err = await plansService
      .addProposals(
        planId,
        [
          {
            op: 'modify',
            workItemId: target.id,
            patch: { obsolescenceNoteMd: 42 as unknown as string },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('`obsolescenceNoteMd`');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
  });

  it('a second modify of one card MERGES both keys — later wins, `null` clears', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await newPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { obsolescence: 'outdated', obsolescenceNoteMd: 'first' },
        },
      ],
      fx.ctx,
    );
    const rowId = first.appendedItemIds[0]!;
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'deprecated' } }],
      fx.ctx,
    );
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: rowId } })).patch).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'first',
    });
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { obsolescenceNoteMd: null } }],
      fx.ctx,
    );
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id: rowId } })).patch).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: null,
    });
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it("correctProposal holds a modify's replacement patch to the same mark check", async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await modifyPlan(fx, target.id, { obsolescence: 'outdated' });
    const id = (await adminDb.planItem.findFirstOrThrow({ where: { planId } })).id;

    const err = await plansService
      .correctProposal(
        planId,
        id,
        { patch: { obsolescence: 'stale' as unknown as 'outdated' } },
        fx.ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as Error).message).toContain('`obsolescence`');
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id } })).patch).toEqual({
      obsolescence: 'outdated',
    });

    await plansService.correctProposal(
      planId,
      id,
      { patch: { obsolescence: 'deprecated' } },
      fx.ctx,
    );
    expect((await adminDb.planItem.findUniqueOrThrow({ where: { id } })).patch).toEqual({
      obsolescence: 'deprecated',
    });
  });
});

describe('approve — writes the mark onto a live card (MOTIR-6629)', () => {
  it('writes both onto a `todo` card with ONE revision carrying both diff cells', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    const planId = await modifyPlan(fx, target.id, {
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'Replaced by the new flow.',
    });
    await closeAndApprove(fx, planId);

    const after = await row(target.id);
    expect(after.obsolescence).toBe('outdated');
    expect(after.obsolescenceNoteMd).toBe('Replaced by the new flow.');

    // ONE revision carries the mark, with both cells (the park's resting-status
    // move records its own, separate revision).
    const revisions = await markRevisions(target.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.diff).toEqual({
      obsolescence: { from: null, to: 'outdated' },
      obsolescenceNoteMd: { from: null, to: 'Replaced by the new flow.' },
    });
  });

  it('an explicit `null` for each clears both', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { obsolescence: 'deprecated', obsolescenceNoteMd: 'Old note.' },
    });

    const planId = await modifyPlan(fx, target.id, {
      obsolescence: null,
      obsolescenceNoteMd: null,
    });
    await closeAndApprove(fx, planId);

    const after = await row(target.id);
    expect(after.obsolescence).toBeNull();
    expect(after.obsolescenceNoteMd).toBeNull();
    const revisions = await markRevisions(target.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.diff).toEqual({
      obsolescence: { from: 'deprecated', to: null },
      obsolescenceNoteMd: { from: 'Old note.', to: null },
    });
  });
});

describe('a MARK-ONLY modify reaches a finished card (MOTIR-6629)', () => {
  it.each(['done', 'cancelled'])(
    'approves on a `%s` card and leaves its status, branch, completion and parent alone',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const parent = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
      await adminDb.workItem.update({ where: { id: parent.id }, data: { status: 'in_progress' } });
      const target = await createTestWorkItem(fx, {
        kind: 'subtask',
        title: 'Finished leaf',
        parentId: parent.id,
      });
      const completedAt = new Date('2026-09-01T00:00:00.000Z');
      await adminDb.workItem.update({
        where: { id: target.id },
        data: { status, sessionBranch: 'parent/MOTIR-1-shipped', completedAt },
      });
      const before = await row(target.id);
      const priorRevisionIds = new Set(
        (await adminDb.workItemRevision.findMany({ where: { workItemId: target.id } })).map(
          (r) => r.id,
        ),
      );

      const planId = await modifyPlan(fx, target.id, {
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Overturned by the new decision.',
      });
      await closeAndApprove(fx, planId);

      const after = await row(target.id);
      expect(after.obsolescence).toBe('deprecated');
      expect(after.obsolescenceNoteMd).toBe('Overturned by the new decision.');
      expect(after.status).toBe(status);
      expect(after.sessionBranch).toBe('parent/MOTIR-1-shipped');
      expect(after.completedAt?.toISOString()).toBe(before.completedAt?.toISOString());
      expect((await row(parent.id)).status).toBe('in_progress');

      // ONE revision, and it is the mark's — no status cell rode along.
      const since = (
        await adminDb.workItemRevision.findMany({ where: { workItemId: target.id } })
      ).filter((r) => !priorRevisionIds.has(r.id));
      expect(since).toHaveLength(1);
      expect(since[0]!.diff).toEqual({
        obsolescence: { from: null, to: 'deprecated' },
        obsolescenceNoteMd: { from: null, to: 'Overturned by the new decision.' },
      });
      // Never parked, so no lock was left behind either.
      expect(await adminDb.planTargetLock.count({ where: { workItemId: target.id } })).toBe(0);
    },
  );

  it('still REFUSES a modify of a `done` card that carries a title beside the mark', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Finished' });
    await adminDb.workItem.update({ where: { id: target.id }, data: { status: 'done' } });

    const planId = await modifyPlan(fx, target.id, {
      title: 'Re-opened by the back door',
      obsolescence: 'outdated',
    });
    const err = await refusalOnTheWay(fx, planId);
    expect(err).toBeInstanceOf(PlanTargetImmutableError);
    expect((err as PlanTargetImmutableError).code).toBe('PLAN_TARGET_IMMUTABLE');

    const after = await row(target.id);
    expect(after.title).toBe('Finished');
    expect(after.obsolescence).toBeNull();
  });

  it('still REFUSES a `remove` of a `done` card', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Finished' });
    await adminDb.workItem.update({ where: { id: target.id }, data: { status: 'done' } });

    const planId = await newPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'remove', workItemId: target.id, reason: 'No longer needed.' }],
      fx.ctx,
    );
    const err = await refusalOnTheWay(fx, planId);
    expect(err).toBeInstanceOf(PlanTargetImmutableError);
    expect((await row(target.id)).archivedAt).toBeNull();
  });

  it("leaves the card's approved-shape verdict `unchanged`", async () => {
    const fx = await makeWorkItemFixture();
    const born = await newPlan(fx);
    await plansService.addProposals(
      born,
      [{ op: 'add', proposedFields: { title: 'Born', kind: 'task' } }],
      fx.ctx,
    );
    await closeAndApprove(fx, born);
    const card = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Born' },
    });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    const marking = await modifyPlan(fx, card.id, { obsolescence: 'outdated' });
    await closeAndApprove(fx, marking);
    expect((await row(card.id)).obsolescence).toBe('outdated');

    const page = await plansService.resolveApprovedShapeVerdict(fx.projectId, [card.id], fx.ctx);
    expect(page.items[0]).toMatchObject({ workItemId: card.id, verdict: 'unchanged' });
  });
});
