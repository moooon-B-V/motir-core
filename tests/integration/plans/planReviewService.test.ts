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

/** One node of a real epic → story → task CHAIN, for the ancestor-trail cases. */
async function seedChild(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'task',
  title: string,
  parentId?: string,
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
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

  // ── The committed ANCESTOR CHAIN (bug MOTIR-3152) ─────────────────────────
  // The canvas breadcrumb walks the whole path down to the arrival level, not
  // its last link. `parentIdentifier` can only ever name the immediate parent, so
  // the canvas synthesised ONE crumb and every ancestor above it was missing —
  // and the crumb it did draw sat under a root labelled "Plan" that navigated to
  // the project roadmap root. The chain has to be carried.

  it('carries the committed ancestor path down to the parent — ROOT FIRST, the parent LAST', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'The agent loop');
    const story = await seedChild(fx, 'story', 'Plan review', epic.id);
    const task = await seedChild(fx, 'task', 'The canvas', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Canvas plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: task.id, proposedFields: { title: 'A proposed subtask' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;

    expect(item.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'The agent loop' },
      { id: story.id, identifier: story.identifier, title: 'Plan review' },
      { id: task.id, identifier: task.identifier, title: 'The canvas' },
    ]);
    // The immediate parent stays exactly what it was — the trail is an addition,
    // and its LAST element is that same parent.
    expect(item.parentTrail.at(-1)!.id).toBe(item.parentNodeId);
  });

  it('is a one-element trail when the committed parent is itself a root', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'A root epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Root plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: epic.id, proposedFields: { title: 'A proposed story' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'A root epic' },
    ]);
  });

  it('is EMPTY for a root proposal, an intra-plan parent, and a deleted parent', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await seedItem(fx, 'Doomed parent');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Mixed plan' }, fx.ctx);
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
        { op: 'add', parentRef: doomed.id, proposedFields: { title: 'An orphaned proposal' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.delete({ where: { id: doomed.id } });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    for (const title of ['A proposed epic', 'A proposed story', 'An orphaned proposal']) {
      expect({ title, trail: review.items.find((i) => i.title === title)!.parentTrail }).toEqual({
        title,
        trail: [],
      });
    }
  });

  // ── MOTIR-3160 (bug MOTIR-3154) — the DECIDED review model ────────────────
  //
  // Two seams that destroyed or mis-keyed the data a decided card is drawn from.
  // Both are read BACK through the review DTO here, which is where the drift
  // would otherwise only show up as a canvas that draws nothing (declined) or a
  // keyless duplicate node (approved).

  it('returns a DECLINED plan its proposals — the rows are the record of the decision', async () => {
    const fx = await makeWorkItemFixture();
    const modifyTarget = await seedItem(fx, 'Left alone');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Refused plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Never created', kind: 'task' } },
        { op: 'modify', workItemId: modifyTarget.id, patch: { title: 'Never applied' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(review.status).toBe('declined');
    expect(review.itemCount).toBe(2);
    expect(review.items).toHaveLength(2);
    expect(review.items.map((i) => i.op).sort()).toEqual(['add', 'modify']);
    expect(review.decidedByName).not.toBeNull();
    expect(review.history.map((h) => h.kind)).toEqual(['created', 'planned', 'declined']);

    // The refused `add` never became anything, so it keys by its own id and has
    // no identifier — inventing one would be the surface asserting a work item
    // that does not exist.
    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.nodeId).toBe(add.planItemId);
    expect(add.identifier).toBeNull();
    expect(add.status).toBeNull();
    expect(add.title).toBe('Never created');
  });

  it('keys a MATERIALIZED add by the work item it became, and names it', async () => {
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Accepted plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Becomes a real card', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // BEFORE the decision: not about anything yet.
    const before = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const pending = before.items[0]!;
    expect(pending.nodeId).toBe(pending.planItemId);
    expect(pending.identifier).toBeNull();
    expect(pending.status).toBeNull();

    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Becomes a real card' },
    });
    const after = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const accepted = after.items[0]!;

    // AFTER: the SAME node as the committed item, not a keyless ghost beside it.
    expect(accepted.nodeId).toBe(created.id);
    expect(accepted.nodeId).not.toBe(accepted.planItemId);
    expect(accepted.identifier).toBe(created.identifier);
    expect(accepted.status).toBe(created.status);
  });

  it('resolves an intra-plan ref to the referenced add NODE id once it materializes', async () => {
    // The rule above makes a node id differ from the plan-item id, so a
    // `planItem:<id>` parent / blocker ref can no longer resolve to the
    // referenced id itself — it has to follow the referenced item to its node,
    // or an approved parent's children point at a node that is not on the canvas.
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Two layers' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Proposed parent', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${first.items[0]!.id}`,
          proposedFields: { title: 'Proposed child', kind: 'task' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const parent = review.items.find((i) => i.title === 'Proposed parent')!;
    const child = review.items.find((i) => i.title === 'Proposed child')!;

    expect(parent.nodeId).not.toBe(parent.planItemId); // materialized
    expect(child.parentNodeId).toBe(parent.nodeId); // …and the child follows it
    expect(parent.hasChildren).toBe(true);
  });

  it('leaves modify / remove node-id resolution exactly as it was', async () => {
    const fx = await makeWorkItemFixture();
    const modifyTarget = await seedItem(fx, 'Modify me');
    const removeTarget = await seedItem(fx, 'Remove me');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: modifyTarget.id, patch: { title: 'Modified' } },
        { op: 'remove', workItemId: removeTarget.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    const remove = review.items.find((i) => i.op === 'remove')!;

    expect(modify.nodeId).toBe(modifyTarget.id);
    expect(modify.identifier).toBe(modifyTarget.identifier);
    expect(remove.nodeId).toBe(removeTarget.id);
    expect(remove.identifier).toBe(removeTarget.identifier);
  });

  // ── The target status's own IDENTITY (bug MOTIR-3170) ────────────────────
  //
  // The canvas chip received a bare status KEY and narrowed it against a
  // six-member literal, so a `modify` whose live target had an open pull request
  // drew as "To Do". The key alone can never fix it — a CUSTOM workflow status
  // has no entry in the `labels.defaultStatus` catalog the chip named itself
  // from — so the review model carries the status's label + category too.
  //
  // The label and category are read off the SAME `target` as `status`, so they
  // follow MOTIR-3160's rule directly: whenever a status is non-null it is
  // nameable, including on a materialized `add` (asserted below).
  it("carries the target status's LABEL and CATEGORY on a modify", async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'A built card');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { status: 'implemented' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Status plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: target.id, patch: { priority: 'high' } },
        { op: 'add', proposedFields: { title: 'A new card', kind: 'task' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.status).toBe('implemented');
    expect(modify.statusLabel).toBe('Implemented');
    expect(modify.statusCategory).toBe('in_progress');

    // An UN-MATERIALIZED `add` has no live target, so it has no status at all —
    // not a defaulted one, which is precisely the failure this card is about.
    const add = review.items.find((i) => i.op === 'add')!;
    expect(add.status).toBeNull();
    expect(add.statusLabel).toBeNull();
    expect(add.statusCategory).toBeNull();
  });

  it('names the status of a MATERIALIZED add too — label and category track `status`', async () => {
    // MOTIR-3160 gave an approved `add` its live target, so it now HAS a status.
    // A status the surface can show but not name is the same defect one card
    // over, so the two identity fields have to move with it rather than keep the
    // `op === 'add'` guard that rule removed.
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(fx.projectId, { title: 'Accepted' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Becomes real and named', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { title: 'Becomes real and named' },
    });
    await adminDb.workItem.update({
      where: { id: created.id },
      data: { status: 'implemented' },
    });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const accepted = review.items[0]!;
    expect(accepted.status).toBe('implemented');
    expect(accepted.statusLabel).toBe('Implemented');
    expect(accepted.statusCategory).toBe('in_progress');
  });

  it("carries a CUSTOM workflow status's own label — the catalog cannot name it", async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Waiting on counsel');
    const anyStatus = await adminDb.workflowStatus.findFirst({
      where: { projectId: fx.projectId },
    });
    await adminDb.workflowStatus.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        key: 'awaiting_legal',
        label: 'Awaiting legal',
        category: 'todo',
        position: `${anyStatus!.position}z`,
        isInitial: false,
      },
    });
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { status: 'awaiting_legal' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Custom plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'high' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.statusLabel).toBe('Awaiting legal');
    expect(modify.statusCategory).toBe('todo');
  });

  it('throws PlanNotFoundError for a missing plan', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      planReviewService.getPlanReview('plan_does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});
