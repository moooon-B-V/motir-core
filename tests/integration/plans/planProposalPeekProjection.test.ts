import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-4183 (story MOTIR-4181) — the PROPOSAL ENVELOPE the peek reads, asserted
// against the real service on real Postgres.
//
// ── Why a NEW file and not the sibling suite ────────────────────────────────
// `planReviewService.test.ts` carries MOTIR-4136, an OPEN whole-file ordering
// flake: its abandoned-plan case asserts on `history.at(-1)` where the lifecycle
// and content events tie on the millisecond, so the sort decides and the file
// goes red run whole / green run alone. MOTIR-4186's criterion 4 asks this
// story's vitest to be green AS A WHOLE FILE, and appending here would inherit a
// failure this story neither caused nor owns. Recorded on MOTIR-4186 before a
// line of this was written.

async function seedTarget(
  fx: WorkItemFixture,
  title: string,
  over: {
    descriptionMd?: string;
    explanationMd?: string;
    priority?: 'low' | 'medium' | 'high' | 'highest';
    type?: 'code' | 'design';
    storyPoints?: number;
    estimateMinutes?: number;
    executor?: 'coding_agent' | 'human';
    targetRepo?: string;
  } = {},
): Promise<{ id: string; identifier: string }> {
  const { targetRepo, ...inline } = over;
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...inline },
    fx.ctx,
  );
  // The column, not the service path: pinning through the real path needs a
  // CONNECTED repository row, and none of these cases is about that validation.
  if (targetRepo) {
    await adminDb.workItem.update({ where: { id: dto.id }, data: { targetRepo } });
  }
  return { id: dto.id, identifier: dto.identifier };
}

const byTitle = (items: PlanReviewItemDto[], t: string): PlanReviewItemDto => {
  const found = items.find((i) => i.title === t);
  if (!found) throw new Error(`no proposal titled ${t}: ${items.map((i) => i.title).join(', ')}`);
  return found;
};

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the proposal envelope the peek reads (MOTIR-4183)', () => {
  it('a MODIFY names its target, and `changedFields` is the SAME set the diff spells (AC 4, 5)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedTarget(fx, 'Seller onboarding', {
      priority: 'medium',
      storyPoints: 3,
      estimateMinutes: 30,
      descriptionMd: 'The onboarding flow as it stands.',
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Peek plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { title: 'Seller onboarding, revised', priority: 'highest', storyPoints: 8 },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = byTitle(review.items, 'Seller onboarding, revised');

    expect(item.proposal.op).toBe('modify');
    // The target's real key — what the panel fetches the payload by.
    expect(item.proposal.identifier).toBe(target.identifier);

    // ⚠️ THE LOAD-BEARING ASSERTION (AC 4). Not "the marker looks right" — the
    // envelope's set and the list row's diff are compared against the SAME
    // fixture, which is what proves they share a source rather than agree by
    // coincidence. A second comparison written for the marker would pass a
    // "looks right" test and drift the first time a field was added to one.
    expect([...item.proposal.changedFields].sort()).toEqual(
      [...item.changes.map((c) => c.field)].sort(),
    );
    // …and it is not vacuously empty: this patch moves three fields.
    expect([...item.proposal.changedFields].sort()).toEqual(
      ['priority', 'storyPoints', 'title'].sort(),
    );
  });

  it('a field the patch does NOT touch is absent from `changedFields` (AC 2)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedTarget(fx, 'Dispute handling', {
      priority: 'medium',
      storyPoints: 5,
      estimateMinutes: 45,
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Narrow plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'high' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = byTitle(
      (await planReviewService.getPlanReview(plan.id, fx.ctx)).items,
      'Dispute handling',
    );
    // "this is not changing" and "there is nothing here" are different facts:
    // the rail still REPORTS the untouched values, and the marker stays off them.
    expect(item.proposal.changedFields).toEqual(['priority']);
    expect(item.storyPoints).toBe(5);
    expect(item.estimateMinutes).toBe(45);
  });

  it('an explicit `null` CLEARS and is REPORTED as a change (AC 3)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedTarget(fx, 'Payout ledger', {
      explanationMd: 'The rationale approval is about to delete.',
      storyPoints: 8,
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Clearing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { explanationMd: null } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = byTitle(
      (await planReviewService.getPlanReview(plan.id, fx.ctx)).items,
      'Payout ledger',
    );
    // Under `??` this would fall through to the target's CURRENT explanation and
    // show the reviewer the text approval is about to DELETE as the text it will
    // keep — MOTIR-4134's own failure mode, inverted.
    expect(item.explanationMd).toBeNull();
    expect(item.proposal.changedFields).toContain('explanation');
  });

  it('a REMOVE reports the target and changes NOTHING (AC 5)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedTarget(fx, 'Manual payout export', {
      descriptionMd: 'Exactly what approving will archive.',
      priority: 'low',
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Archive plan' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: target.id }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = byTitle(
      (await planReviewService.getPlanReview(plan.id, fx.ctx)).items,
      'Manual payout export',
    );
    expect(item.proposal.op).toBe('remove');
    expect(item.proposal.identifier).toBe(target.identifier);
    // A `remove` carries no patch, so no row is ever marked — which is what
    // lets the peek show the target's values as *what will be archived*.
    expect(item.proposal.changedFields).toEqual([]);
    expect(item.descriptionMd).toBe('Exactly what approving will archive.');
  });

  it('an un-materialized ADD has a NULL identifier — the signal that there is no payload to fetch (AC 6)', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Additive plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Reconcile ledger rows',
            kind: 'task',
            descriptionMd: 'What approval will create.',
            explanationMd: 'Why it matters.',
            priority: 'high',
            storyPoints: 5,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = byTitle(
      (await planReviewService.getPlanReview(plan.id, fx.ctx)).items,
      'Reconcile ledger rows',
    );
    expect(item.proposal.op).toBe('add');
    // `null` IS the decision, not a missing value: no key, so the host makes no
    // peek request and the proposed values below are the whole of what exists.
    expect(item.proposal.identifier).toBeNull();
    // Nothing is "changed" on an `add` — the whole work item is proposed, which
    // the peek says in words at the rail's foot rather than by marking every row.
    expect(item.proposal.changedFields).toEqual([]);
    // …and the proposed values ARE reported, so the peek has something to render.
    expect(item.descriptionMd).toBe('What approval will create.');
    expect(item.explanationMd).toBe('Why it matters.');
    expect(item.priority).toBe('high');
    expect(item.storyPoints).toBe(5);
  });

  it('every op carries the SETTABLE set, so the count line has its denominator (AC 9)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedTarget(fx, 'Tax rates');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Mixed plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Credit notes', kind: 'task' } },
        { op: 'modify', workItemId: target.id, patch: { priority: 'high' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    for (const item of review.items) {
      expect(item.proposal.settableRailFields).toEqual(PLAN_ITEM_SETTABLE_RAIL_FIELDS);
      expect(item.proposal.settableRailFields).toHaveLength(6);
      // The marker can never mark a rail row the denominator does not count.
      const railChanges = item.proposal.changedFields.filter((f) =>
        (PLAN_ITEM_SETTABLE_RAIL_FIELDS as readonly string[]).includes(f),
      );
      expect(railChanges.length).toBeLessThanOrEqual(item.proposal.settableRailFields.length);
    }
  });

  it('adds a READING without moving one — the node/row fields are untouched (AC 8)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedTarget(fx, 'Invoice templates', { priority: 'medium' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Parity plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { title: 'Invoice templates + branding' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = byTitle(
      (await planReviewService.getPlanReview(plan.id, fx.ctx)).items,
      'Invoice templates + branding',
    );
    // The canvas node and the list row read these, and this story must add a
    // reading without moving one: the headline is still the PROPOSED title
    // (MOTIR-4018), the key is still the committed one, and the diff still
    // spells old→new (Part VIII §3).
    expect(item.title).toBe('Invoice templates + branding');
    expect(item.identifier).toBe(target.identifier);
    expect(item.changes).toEqual([
      { field: 'title', from: 'Invoice templates', to: 'Invoice templates + branding' },
    ]);
  });
});
