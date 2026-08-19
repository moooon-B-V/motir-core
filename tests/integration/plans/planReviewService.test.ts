import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Integration tests for Subtask 7.4.5 / MOTIR-847 — `planReviewService`, the
// READ assembly behind the plan-detail UI. Real Postgres (no mocks), per
// CLAUDE.md. Proves the assembly the canvas + review rail bind to:
//   • each proposed op is enriched for rendering — an `add` from its proposed
//     fields (no identifier/status yet), a `modify` as the LIVE target plus an
//     old→new diff, a `remove` as the live target marked for archive;
//   • the history timeline tracks the lifecycle (created → planned → decision),
//     with the decider's NAME resolved on a decided plan;
//   • a fresh plan over an unchanged tree is not stale;
//   • a missing/cross-tenant plan is a typed PlanNotFoundError (the route → 404).
//
// This is also the story's integration SEAM: it reads `plansService`/staleness
// output BACK through the review DTO the client consumes, catching key drift the
// unit layers mask.

async function seedItem(
  fx: WorkItemFixture,
  title: string,
  priority?: 'low' | 'medium' | 'high',
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...(priority ? { priority } : {}) },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('planReviewService.getPlanReview', () => {
  it('enriches add / modify / remove and builds the history timeline', async () => {
    const fx = await makeWorkItemFixture();
    const modifyTarget = await seedItem(fx, 'Seller onboarding', 'medium');
    const removeTarget = await seedItem(fx, 'Manual payout export');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Payouts plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Marketplace payouts', kind: 'epic' } },
        {
          op: 'modify',
          workItemId: modifyTarget.id,
          patch: { title: 'Seller onboarding v2', priority: 'high' },
          baseRevision: 'r1',
        },
        { op: 'remove', workItemId: removeTarget.id, baseRevision: 'r1' },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(review.status).toBe('planned');
    expect(review.itemCount).toBe(3);

    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.identifier).toBeNull();
    expect(add.status).toBeNull();
    expect(add.title).toBe('Marketplace payouts');
    expect(add.kind).toBe('epic');
    expect(add.nodeId).toBe(add.planItemId);
    expect(add.stale).toBe(false); // an add with no parent/blockers has no drift

    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.identifier).toBe(modifyTarget.identifier);
    expect(modify.nodeId).toBe(modifyTarget.id); // SAME id — not a ghost copy
    expect(modify.targetMissing).toBe(false);
    const priorityChange = modify.changes.find((c) => c.field === 'priority');
    expect(priorityChange).toEqual({ field: 'priority', from: 'medium', to: 'high' });
    expect(modify.changes.find((c) => c.field === 'title')?.to).toBe('Seller onboarding v2');

    // Staleness is JOINED into the model: the modify's stale `baseRevision` (`r1`
    // never matches the target's real latest revision) surfaces as a drift reason,
    // and the plan-level roll-up reflects it.
    expect(modify.stale).toBe(true);
    expect(modify.staleReasons.some((r) => r.code === 'base_revision_drift')).toBe(true);
    expect(review.stale).toBe(true);
    expect(review.staleCount).toBeGreaterThanOrEqual(1);

    const remove = review.items.find((i) => i.op === 'remove')!;
    expect(remove.identifier).toBe(removeTarget.identifier);
    expect(remove.title).toBe('Manual payout export');
    expect(remove.targetMissing).toBe(false);

    // History: created + planned, no decision yet, no decider.
    expect(review.history.map((h) => h.kind)).toEqual(['created', 'planned']);
    expect(review.decidedByName).toBeNull();
  });

  it('surfaces a leaf-sizing re-scope in the change preview so the approver SEES it (MOTIR-1532)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Resized card');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { storyPoints: 3, estimateMinutes: 45 },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-scope plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { storyPoints: 8, estimateMinutes: 90 } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes.find((c) => c.field === 'storyPoints')).toEqual({
      field: 'storyPoints',
      from: '3',
      to: '8',
    });
    expect(modify.changes.find((c) => c.field === 'estimateMinutes')).toEqual({
      field: 'estimateMinutes',
      from: '45',
      to: '90',
    });
  });

  it('surfaces a rewritten EXPLANATION in the change preview so the approver SEES it (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose WHY moved');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { explanationMd: 'The rationale as first planned.' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-explain plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { explanationMd: 'The rationale the re-scope leaves behind.' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    // Long prose, so the cell says only THAT it moved — the same treatment the
    // description gets. It is listed at all because the explanation is the half a
    // reviewer reads to decide whether a proposed re-shape is right; a `modify`
    // that rewrote it invisibly would defeat the point of the review surface.
    expect(modify.changes.find((c) => c.field === 'explanation')).toEqual({
      field: 'explanation',
      from: null,
      to: 'updated',
    });
  });

  it('says NOTHING about the explanation when the patch does not carry one (MOTIR-3111)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose WHY stands');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { explanationMd: 'Still right.' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-title plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'A new title' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes.map((c) => c.field)).toEqual(['title']);
  });

  it('resolves the decider name + an approved history event after approve', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Tiny plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A new task', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(review.status).toBe('approved');
    expect(review.stale).toBe(false); // an add-only plan over an unchanged tree
    expect(review.decidedByName).toBe(fx.owner.name);
    const decision = review.history.find((h) => h.kind === 'approved');
    expect(decision).toBeDefined();
    expect(decision!.byName).toBe(fx.owner.name);
    expect(decision!.at).not.toBeNull();
  });

  // ── The COMMITTED parent (MOTIR-3083) ──────────────────────────────────────
  // The canvas opens a LEVEL at this parent and the breadcrumb names it, so the
  // review model has to carry it. Before this it carried no field that could:
  // a proposal under a committed item drew at the top level, indistinguishable
  // from a genuine root.

  it('resolves the COMMITTED parent a proposal will be created under', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await seedItem(fx, 'Payouts epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Payouts plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: parent.id, proposedFields: { title: 'Seller ledger' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentNodeId).toBe(parent.id);
    expect(item.parentIdentifier).toBe(parent.identifier);
    expect(item.parentTitle).toBe('Payouts epic');
    expect(item.parentKind).toBe('task');
  });

  it('leaves the parent fields NULL for a root and for an intra-plan parent', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Fresh tree' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A proposed epic', kind: 'epic' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${first.items[0]!.id}`,
          proposedFields: { title: 'A proposed story', kind: 'story' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const root = review.items.find((i) => i.title === 'A proposed epic')!;
    const child = review.items.find((i) => i.title === 'A proposed story')!;

    // A genuine root: nothing to name.
    expect(root.parentIdentifier).toBeNull();
    // An intra-plan parent already HAS a node in the proposed set, so it needs no
    // resolution — the canvas draws it, the breadcrumb does not.
    expect(child.parentNodeId).toBe(root.nodeId);
    expect(child.parentIdentifier).toBeNull();
  });

  it('DEGRADES to the root rendering when the parent has been archived', async () => {
    // Never throw over a parent that no longer resolves: an unreadable parent is
    // the same rendering a genuine root gets.
    const fx = await makeWorkItemFixture();
    const parent = await seedItem(fx, 'Doomed parent');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Orphan plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: parent.id, proposedFields: { title: 'Orphaned proposal' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.delete({ where: { id: parent.id } });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentIdentifier).toBeNull();
    expect(item.parentTitle).toBeNull();
  });

  it('throws PlanNotFoundError for a missing plan', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      planReviewService.getPlanReview('plan_does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});
