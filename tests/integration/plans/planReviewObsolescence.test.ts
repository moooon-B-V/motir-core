import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import type { PlanItemPatch } from '@/lib/dto/plans';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6577 · MOTIR-6632 — the plan REVIEW model carries a proposed
// obsolescence MARK (`design/ai-planning/design-notes.md` Part XXIV §24.12),
// asserted against the real service on real Postgres:
//
//   • a `modify`'s `changes` carry the mark group: `obsolescence` old → new in
//     wire words (`current` for no mark, the old side read off the LIVE card), the
//     note's whole text, and one row per supersedes DIRECTION with resolved chips;
//   • `proposal.markChanges` is the same rows, and `changedFields` names them;
//   • an `add`'s `supersedesRefs` are resolved to chips on the item and envelope —
//     a committed card by key, a proposal of this plan as that proposal, and after
//     approve by the key approve CREATED;
//   • a plan with no marks produces a DTO identical to before for every field.
//
// The renderers are driven off this shape in
// `tests/components/plan-review-obsolescence.test.tsx`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function doneCard(
  fx: WorkItemFixture,
  title: string,
  mark: WorkItemObsolescenceDto | null = null,
  kind: 'task' | 'story' = 'task',
) {
  const card = await createTestWorkItem(fx, { kind, title });
  // The columns, not the service path: these cases are about the REVIEW read.
  await adminDb.workItem.update({
    where: { id: card.id },
    data: { status: 'done', obsolescence: mark },
  });
  return card;
}

async function newPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Marks' }, fx.ctx)).id;
}

async function review(fx: WorkItemFixture, planId: string) {
  await plansService.markPlanned(planId, fx.ctx);
  return planReviewService.getPlanReview(planId, fx.ctx);
}

async function reviewOfModify(
  fx: WorkItemFixture,
  target: { id: string },
  patch: PlanItemPatch,
): Promise<PlanReviewItemDto> {
  const planId = await newPlan(fx);
  await plansService.addProposals(planId, [{ op: 'modify', workItemId: target.id, patch }], fx.ctx);
  return (await review(fx, planId)).items.find((i) => i.op === 'modify')!;
}

const MARK_FIELDS = ['obsolescence', 'obsolescenceNote', 'supersedes', 'supersededBy'];

describe('a `modify` that MARKS a finished card', () => {
  it('SETS outdated: `current → outdated`, the whole note, and nothing else', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Deliver webhooks at most once');
    const note = 'Delivery is now exactly-once.\nThe at-most-once contract is replaced.';
    const item = await reviewOfModify(fx, target, {
      obsolescence: 'outdated',
      obsolescenceNoteMd: note,
    });

    expect(item.changes).toEqual([
      { field: 'obsolescence', from: 'current', to: 'outdated' },
      { field: 'obsolescenceNote', from: null, to: note },
    ]);
    // No status row: a mark never moves the card (§24.4).
    expect(item.changes.some((c) => c.field === 'status')).toBe(false);
    expect(item.status).toBe('done');
    expect(item.statusCategory).toBe('done');
    // One source: the envelope's rows are the item's mark rows, and the count set.
    expect(item.proposal.markChanges).toEqual(item.changes);
    expect(item.proposal.changedFields).toEqual(['obsolescence', 'obsolescenceNote']);
    for (const f of MARK_FIELDS) expect(item.proposal.settableRailFields).toContain(f);
    expect(item.proposal.settableRailFields).toHaveLength(11);
  });

  it('CHANGES outdated → deprecated — the FROM side is the live card’s mark', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Poll the bank feed', 'outdated');
    const item = await reviewOfModify(fx, target, { obsolescence: 'deprecated' });
    expect(item.changes).toEqual([{ field: 'obsolescence', from: 'outdated', to: 'deprecated' }]);
  });

  it('CLEARS a mark: `deprecated → current`, and a cleared note is null', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Sign payloads', 'deprecated');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { obsolescenceNoteMd: 'old why' },
    });
    const item = await reviewOfModify(fx, target, {
      obsolescence: null,
      obsolescenceNoteMd: null,
    });
    expect(item.changes).toEqual([
      { field: 'obsolescence', from: 'deprecated', to: 'current' },
      { field: 'obsolescenceNote', from: null, to: null },
    ]);
  });

  it('a patch re-stating the current mark moves nothing and draws nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Already outdated', 'outdated');
    const item = await reviewOfModify(fx, target, { obsolescence: 'outdated' });
    expect(item.changes.filter((c) => c.field === 'obsolescence')).toEqual([]);
  });

  it('supersedes edges: one row per DIRECTION, each ref a resolved chip, `−` for a removal', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Retry policy');
    const older = await doneCard(fx, 'Backoff schedule', null, 'story');
    const removed = await doneCard(fx, 'Retry three times');
    const newer = await doneCard(fx, 'Receive by push');
    const planId = await newPlan(fx);
    // An `add` from an EARLIER call — a `planItem:` ref may not name the same batch.
    const first = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Exactly-once delivery', kind: 'task' } }],
      fx.ctx,
    );
    const addId = first.appendedItemIds[0]!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: {
            supersedesAdd: [older.id],
            supersedesRemove: [removed.id],
            supersededByAdd: [`planItem:${addId}`, newer.id],
          },
        },
      ],
      fx.ctx,
    );
    const item = (await review(fx, planId)).items.find((i) => i.op === 'modify')!;

    const supersedes = item.changes.find((c) => c.field === 'supersedes')!;
    expect(supersedes.from).toBeNull();
    expect(supersedes.to).toBe(`+${older.identifier} · −${removed.identifier}`);
    expect(supersedes.refs).toEqual({
      added: [
        { identifier: older.identifier, title: 'Backoff schedule', kind: 'story', proposed: false },
      ],
      removed: [
        {
          identifier: removed.identifier,
          title: 'Retry three times',
          kind: 'task',
          proposed: false,
        },
      ],
    });

    const by = item.changes.find((c) => c.field === 'supersededBy')!;
    expect(by.refs!.added).toEqual([
      {
        identifier: null,
        title: 'Exactly-once delivery',
        kind: 'task',
        proposed: true,
        planItemId: addId,
      },
      { identifier: newer.identifier, title: 'Receive by push', kind: 'task', proposed: false },
    ]);
    // Never the temp-ref on the wire's words either.
    expect(by.to).not.toContain('planItem:');
    expect(item.proposal.changedFields).toEqual(['supersedes', 'supersededBy']);
    expect(item.proposal.markChanges).toEqual([supersedes, by]);
  });
});

describe('an `add` that supersedes cards', () => {
  it('resolves its refs to chips on the item and the envelope — a committed key and a proposal', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneCard(fx, 'Old contract', null, 'story');
    const planId = await newPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'New contract', kind: 'task' },
          supersedesRefs: [old.id],
        },
      ],
      fx.ctx,
    );
    const firstId = first.appendedItemIds[0]!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Newer still', kind: 'task' },
          supersedesRefs: [`planItem:${firstId}`],
        },
        { op: 'add', proposedFields: { title: 'Plain', kind: 'task' } },
      ],
      fx.ctx,
    );
    const byTitle = new Map((await review(fx, planId)).items.map((i) => [i.title, i]));

    const newContract = byTitle.get('New contract')!;
    expect(newContract.supersedesRefs).toEqual([
      { identifier: old.identifier, title: 'Old contract', kind: 'story', proposed: false },
    ]);
    expect(newContract.proposal.supersedesRefs).toEqual(newContract.supersedesRefs);
    // An `add` has no diff and no mark rows.
    expect(newContract.changes).toEqual([]);
    expect(newContract.proposal.markChanges).toEqual([]);

    expect(byTitle.get('Newer still')!.supersedesRefs).toEqual([
      {
        identifier: null,
        title: 'New contract',
        kind: 'task',
        proposed: true,
        planItemId: firstId,
      },
    ]);
    // No refs ⇒ nothing.
    expect(byTitle.get('Plain')!.supersedesRefs).toEqual([]);
  });

  it('after approve, a proposal chip names the key approve CREATED', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await newPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'New contract', kind: 'task' } }],
      fx.ctx,
    );
    const firstId = first.appendedItemIds[0]!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Newer still', kind: 'task' },
          supersedesRefs: [`planItem:${firstId}`],
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    const after = await planReviewService.getPlanReview(planId, fx.ctx);
    const created = after.items.find((i) => i.planItemId === firstId)!;
    const newer = after.items.find((i) => i.title === 'Newer still')!;
    expect(created.identifier).not.toBeNull();
    expect(newer.supersedesRefs).toEqual([
      {
        identifier: created.identifier,
        title: 'New contract',
        kind: 'task',
        proposed: false,
        planItemId: firstId,
      },
    ]);
  });
});

describe('a plan with no marks', () => {
  it('produces no mark rows, no chips and an empty markChanges', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Seller onboarding' });
    const item = await reviewOfModify(fx, target, { priority: 'high' });
    expect(item.changes.map((c) => c.field)).toEqual(['priority']);
    expect(item.changes[0]).not.toHaveProperty('refs');
    expect(item.proposal.markChanges).toEqual([]);
    expect(item.supersedesRefs).toEqual([]);
    expect(item.proposal.supersedesRefs).toEqual([]);
  });
});
