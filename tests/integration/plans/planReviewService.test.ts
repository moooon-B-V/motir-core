import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

/**
 * The LIFECYCLE spine of a timeline (MOTIR-3536).
 *
 * The rail's history is one merged sequence since the plan gained a content
 * trail: an `appended` / `edited` row sits between the lifecycle events wherever
 * a fixture appended or deepened a proposal. Every assertion below that predates
 * that merge is a claim about the LIFECYCLE — which of the three endings a
 * `declined` plan reads as (MOTIR-3189), whether a `planned` event exists at all
 * — so it keeps making exactly that claim, over exactly those rows, rather than
 * being widened to absorb whatever the fixture happened to append. The content
 * rows have their own suite (`planTimelineMerge.test.ts`).
 */
const LIFECYCLE_KINDS = new Set([
  'created',
  'planned',
  'approved',
  'declined',
  'discarded',
  'abandoned',
]);
function lifecycleKinds(history: { kind: string }[]): string[] {
  return history.map((h) => h.kind).filter((k) => LIFECYCLE_KINDS.has(k));
}

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
    expect(lifecycleKinds(review.history)).toEqual(['created', 'planned']);
    expect(review.decidedByName).toBeNull();
  });

  // ── THE TITLE A PROPOSAL IS ASKING FOR (MOTIR-4018, design Part XIII §1) ──
  //
  // The model used to report the TARGET's live title for every non-`add` op, so
  // a plan renaming a card drew the node, its crumb, its search text and the list
  // row's headline under the name the card is about to stop being called — while
  // the same response carried the proposed one three lines away as a `changes`
  // row. All four ops are asserted together, because the defect is not "a modify
  // is wrong" but "the field means two different things depending on the op".
  it('reports a MODIFY’s `patch.title`, and leaves add / remove / an untitled patch exactly as they were (MOTIR-4018)', async () => {
    const fx = await makeWorkItemFixture();
    const renamed = await seedItem(fx, 'Invoice templates');
    const rescoped = await seedItem(fx, 'Dunning emails', 'low');
    const archived = await seedItem(fx, 'Legacy CSV export');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Usage metering', kind: 'story' } },
        // (1) a modify that RENAMES
        { op: 'modify', workItemId: renamed.id, patch: { title: 'Invoice templates + branding' } },
        // (2) a modify whose patch carries NO title — the sparse-patch case, and
        //     the one a naive `patch.title` read would report as undefined.
        { op: 'modify', workItemId: rescoped.id, patch: { priority: 'high' } },
        // (3) a remove, which has no proposed title and never did
        { op: 'remove', workItemId: archived.id },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const byTarget = (id: string) => review.items.find((i) => i.nodeId === id)!;

    expect(review.items.find((i) => i.op === 'add')!.title).toBe('Usage metering');
    expect(byTarget(renamed.id).title).toBe('Invoice templates + branding');
    expect(byTarget(rescoped.id).title).toBe('Dunning emails');
    expect(byTarget(archived.id).title).toBe('Legacy CSV export');
  });

  it('keeps BOTH sides of the rename in `changes` — the diff is untouched by MOTIR-4018', async () => {
    // The node is a SIGNAL and the list is where a change is SPELLED (Part VIII
    // §3). So `title` says what the card will BE and the diff says what it is
    // leaving; a card that reported the proposed title in both would have taken
    // the outgoing name off the one surface that shows it.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Invoice templates');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'Invoice templates + branding' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const item = (await planReviewService.getPlanReview(plan.id, fx.ctx)).items[0]!;
    expect(item.changes.find((c) => c.field === 'title')).toEqual({
      field: 'title',
      from: 'Invoice templates',
      to: 'Invoice templates + branding',
    });
    expect(item.identifier).toBe(target.identifier); // still anchored to the real key
  });

  // ── THE ARRIVAL LEVEL'S SIZE (MOTIR-4024, design Part XIII §6) ─────────────
  //
  // The client cannot compute it: `defaultPlanView` runs before the canvas has
  // fetched anything, and the answer is about the level's COMMITTED
  // neighbourhood, which the plan's own items say nothing about. All three
  // container shapes are covered here because each resolves differently — and the
  // proposal case is the one a naive implementation gets wrong by counting the
  // children of an id no work item has.
  it('counts the arrival level under a COMMITTED parent — its siblings PLUS the plan’s adds (MOTIR-4024)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Billing overhaul');
    for (let i = 0; i < 4; i += 1) await seedChild(fx, 'story', `Committed ${i}`, epic.id);
    const modified = await seedChild(fx, 'story', 'Invoice templates', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Billing plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Usage metering', kind: 'story' },
          parentRef: epic.id,
        },
        { op: 'add', proposedFields: { title: 'Credit notes', kind: 'story' }, parentRef: epic.id },
        // A `modify` SHARES its node with the committed card it targets, so it
        // must NOT be counted again — the level draws five committed cards, not
        // six, and this is the assertion that says so.
        { op: 'modify', workItemId: modified.id, patch: { title: 'Invoice templates + branding' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.arrivalLevelSize).toBe(7); // 5 committed + 2 adds
    expect(review.arrivalLevelTotal).toBe(7); // nothing truncated
  });

  it('counts ZERO committed siblings when the arrival container is itself a PROPOSAL', async () => {
    // The shape an agent-authored skeleton produces almost every time: a story
    // under a committed epic, with its subtasks hung off the story by intra-plan
    // ref. The fullest container is then the PROPOSED story, and no work item
    // carries that id — so the count is the plan's own adds and nothing else.
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Marketplace payouts');
    await seedChild(fx, 'story', 'A committed sibling', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Reconciliation' }, fx.ctx);
    const after = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Payout reconciliation', kind: 'story' },
          parentRef: epic.id,
        },
      ],
      fx.ctx,
    );
    const storyItemId = after.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      ['Reconcile rows', 'Backfill payouts', 'Alert on drift'].map((title) => ({
        op: 'add' as const,
        proposedFields: { title, kind: 'subtask' as const },
        parentRef: `planItem:${storyItemId}`,
      })),
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // The proposed story holds three subtasks and is the fullest container.
    expect(review.arrivalLevelSize).toBe(3);
    expect(review.arrivalLevelTotal).toBe(3);
  });

  it('counts the project ROOT for a plan of pure roots', async () => {
    const fx = await makeWorkItemFixture();
    await seedChild(fx, 'epic', 'A committed root epic');
    await seedChild(fx, 'epic', 'Another root epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Roots' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A proposed root', kind: 'epic' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // `parentId: null` scoped by project — the root level, not every project's.
    expect(review.arrivalLevelSize).toBe(3);
    expect(review.arrivalLevelTotal).toBe(3);
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
    // ⚠️ BOTH SIDES, previewed (bug MOTIR-3191). This used to read
    // `from: null, to: 'updated'` — a notification that the half a reviewer most
    // needs to judge had moved, with no way to see where to. Long prose is still
    // previewed rather than carried whole; a preview of the ACTUAL values is a
    // diff, and the word "updated" was not.
    expect(modify.changes.find((c) => c.field === 'explanation')).toEqual({
      field: 'explanation',
      from: 'The rationale as first planned.',
      to: 'The rationale the re-scope leaves behind.',
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

  // ── WHERE THE CARD SHIPS (bug MOTIR-3868) ────────────────────────────────
  // The SHIPS half of D3's `SITS or SHIPS` pair. Both keys reached `applyModify`
  // and neither reached `buildChanges`, so a `modify` carrying only a re-pin
  // rendered as a proposal with an EMPTY change list — a row that says a card is
  // being changed and declines to say how.

  it('surfaces a repo RE-PIN in the change preview so the approver SEES it (MOTIR-3868)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card that moves repo');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { targetRepo: 'motir-core' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-pin plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepo: 'motir-ai' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes.find((c) => c.field === 'targetRepo')).toEqual({
      field: 'targetRepo',
      from: 'motir-core',
      to: 'motir-ai',
    });
  });

  it('renders a NON-EMPTY change list for a modify whose ONLY change is a re-pin (MOTIR-3868)', async () => {
    // ⚠️ THE DEFECT'S WHOLE SHAPE, asserted directly. An empty `changes` array is
    // a legal, ordinary value elsewhere (a `remove` has one), so nothing rendered
    // wrong and nothing failed — the approver's only options were to approve a
    // change they could not see or to decline a plan that may have been entirely
    // correct. A count assertion is what this case needs; a per-field `find` on a
    // short vocabulary passes vacuously on `undefined`.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose only change is where it ships');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { targetRepo: 'motir-core' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Pin-only plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepo: 'motir-ai' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes).not.toHaveLength(0);
    expect(modify.changes.map((c) => c.field)).toEqual(['targetRepo']);
  });

  it('renders an explicit UNPIN as an empty NEW side, and says nothing when the key is absent (MOTIR-3868)', async () => {
    // Sparse in BOTH directions — the half a `find`-based assertion cannot state.
    const fx = await makeWorkItemFixture();
    const unpinned = await seedItem(fx, 'Card that loses its pin');
    const untouched = await seedItem(fx, 'Card whose pin stands');
    await adminDb.workItem.updateMany({
      where: { id: { in: [unpinned.id, untouched.id] } },
      data: { targetRepo: 'motir-core' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Unpin plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: unpinned.id, patch: { targetRepo: null } },
        { op: 'modify', workItemId: untouched.id, patch: { title: 'Renamed only' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const unpin = review.items.find((i) => i.nodeId === unpinned.id)!;
    expect(unpin.changes).toEqual([{ field: 'targetRepo', from: 'motir-core', to: null }]);

    const stands = review.items.find((i) => i.nodeId === untouched.id)!;
    expect(stands.changes.map((c) => c.field)).toEqual(['title']);
  });

  it('surfaces a repo ROLE re-pin on KEY PRESENCE, with no old side to read (MOTIR-3868)', async () => {
    // ⚠️ `work_item.targetRepoRole` is RETIRED (MOTIR-2732 · MOTIR-3040), so the
    // target cannot supply a `from` and a difference cannot be computed. Presence
    // is the right trigger anyway: `applyModify` rewrites the item's repository
    // REFERENCE whenever this key is present, including when the resolved name
    // does not change — so the row appears exactly when the approve will act.
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card that changes repo ROLE');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-role plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { targetRepoRole: 'api' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items.find((i) => i.op === 'modify')!;
    expect(modify.changes).toEqual([{ field: 'targetRepoRole', from: null, to: 'api' }]);
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
      [
        {
          op: 'add',
          parentRef: parent.id,
          proposedFields: { title: 'Seller ledger', kind: 'subtask' },
        },
      ],
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
      [
        {
          op: 'add',
          parentRef: parent.id,
          proposedFields: { title: 'Orphaned proposal', kind: 'subtask' },
        },
      ],
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
      [
        {
          op: 'add',
          parentRef: task.id,
          proposedFields: { title: 'A proposed subtask', kind: 'subtask' },
        },
      ],
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
        {
          op: 'add',
          parentRef: doomed.id,
          proposedFields: { title: 'An orphaned proposal', kind: 'subtask' },
        },
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

  // ── bug MOTIR-3191 — a proposal ABOUT an existing card sits where that card
  // sits ───────────────────────────────────────────────────────────────────────
  //
  // A `modify` / `remove` carries no `parentRef` and cannot: its parent is the
  // live card's, and the contract forbids a proposal from re-parenting anything.
  // Placement read off `parentRef` alone therefore came back null, which every
  // consumer draws as A ROOT — so an amendment to a subtask five levels down drew
  // beside the `add`s the plan rules reserve the project root for. A plan of two
  // modifies was declined on exactly that reading, and the reading was correct.
  //
  // These read the placement BACK through the review DTO, which is the only place
  // the canvas, the breadcrumb and `get_plan` all agree from.

  it('places a MODIFY at its target’s live position — parent, trail and all (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'The agent loop');
    const story = await seedChild(fx, 'story', 'Plan review', epic.id);
    const task = await seedChild(fx, 'task', 'The canvas', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Amend one card' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: task.id, patch: { title: 'The canvas, redrawn' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const modify = review.items[0]!;

    // THE assertion: the target's position, not the root.
    expect(modify.parentNodeId).toBe(story.id);
    expect(modify.parentIdentifier).toBe(story.identifier);
    expect(modify.parentTitle).toBe('Plan review');
    expect(modify.parentKind).toBe('story');
    // …and the whole committed chain down to it, so the canvas opens at the level
    // the card lives on rather than at the project root.
    expect(modify.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'The agent loop' },
      { id: story.id, identifier: story.identifier, title: 'Plan review' },
    ]);
  });

  it('places a REMOVE the same way — the op differs, the reason does not (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Payouts');
    const task = await seedChild(fx, 'task', 'Manual payout export', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Drop one card' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: task.id }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.parentNodeId).toBe(epic.id);
    expect(review.items[0]!.parentTrail).toEqual([
      { id: epic.id, identifier: epic.identifier, title: 'Payouts' },
    ]);
  });

  it('leaves a MODIFY of a genuinely ROOT card at the root (MOTIR-3191)', async () => {
    // The inherited parent is the TARGET's parent, whatever that is — including
    // none. A root card's amendment belongs at the root, and reads as one.
    const fx = await makeWorkItemFixture();
    const rootCard = await seedChild(fx, 'epic', 'A root epic');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Amend a root' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: rootCard.id, patch: { title: 'A root epic, renamed' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.parentNodeId).toBeNull();
    expect(review.items[0]!.parentIdentifier).toBeNull();
    expect(review.items[0]!.parentTrail).toEqual([]);
  });

  it('DEGRADES a modify whose target is gone to the root rendering (MOTIR-3191)', async () => {
    // No target ⇒ no parent to inherit. The same degrade-rather-than-throw
    // contract an archived `parentRef` already had (MOTIR-3083 AC 5).
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'Doomed branch');
    const doomed = await seedChild(fx, 'task', 'Doomed card', epic.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Amend a ghost' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: doomed.id, patch: { title: 'Never lands' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.delete({ where: { id: doomed.id } });

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.targetMissing).toBe(true);
    expect(review.items[0]!.parentNodeId).toBeNull();
    expect(review.items[0]!.parentTrail).toEqual([]);
  });

  it('places BOTH halves of a mixed plan — an add under its proposed parent, a modify under its target’s (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await seedChild(fx, 'epic', 'The agent loop');
    const storyA = await seedChild(fx, 'story', 'Where the add goes', epic.id);
    const storyB = await seedChild(fx, 'story', 'Where the target lives', epic.id);
    const target = await seedChild(fx, 'task', 'An existing card', storyB.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'A mixed plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', parentRef: storyA.id, proposedFields: { title: 'A brand new card' } },
        { op: 'modify', workItemId: target.id, patch: { title: 'An existing card, re-scoped' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    // Two different levels — which is the drill-down model working, not a gap.
    expect(add.parentNodeId).toBe(storyA.id);
    expect(modify.parentNodeId).toBe(storyB.id);
    expect(modify.parentTrail.map((c) => c.id)).toEqual([epic.id, storyB.id]);
    // Neither is at the root, and the two do not collapse onto one level.
    expect(add.parentNodeId).not.toBe(modify.parentNodeId);
  });

  // ── bug MOTIR-3366 — a proposed EDGE reaches the canvas whichever CARRIER it
  // travels on ────────────────────────────────────────────────────────────────
  //
  // A plan's `blocked_by` edges have TWO carriers: an `add` names its blockers in
  // its own `blockedByRefs`, and a `modify` names them in `patch.blockedByAdd` —
  // the only way to propose an edge ONTO a card that already exists, and so the
  // shape every mid-run correction takes (`add` the prerequisite, `modify` the
  // in-flight card to be blocked by it, one approval for both).
  //
  // `blockedByNodeIds` was built from the first carrier alone, so the second
  // reached the review model as an EMPTY array: `mergePlanLevel` had nothing to
  // draw, and the added card rendered beside the card it blocks with no line
  // between them. Ten such proposals were approved in the dogfooding tenant and
  // not one drew its arrow — while the same patch was already being read eleven
  // lines away to produce the `links` diff row. Present as a counted word,
  // absent as a shape.
  //
  // These assert the EDGE SET the canvas consumes, which is the only place the
  // two carriers are supposed to become one thing.

  it('resolves a MODIFY’s `patch.blockedByAdd` into `blockedByNodeIds` (MOTIR-3366)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'Warm sync worker');
    const inFlight = await seedChild(fx, 'task', 'The worker lifecycle', story.id);

    // The correction shape: propose the prerequisite, and block the in-flight
    // card on it, so one approval lands both halves.
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Split the runtime out' },
      fx.ctx,
    );
    const afterAdd = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: story.id,
          proposedFields: { title: 'The RESIDENT worker runtime' },
        },
      ],
      fx.ctx,
    );
    const addId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: inFlight.id,
          // ⚠️ ONE ref, not two. The duplicate this test used to send is now
          // refused at the APPEND (MOTIR-3573) — a blocker named twice is a
          // pure property of the proposal set, so it never reaches a plan at
          // all and the review layer can no longer be handed one. That
          // rejection is covered in `authoringGates.test.ts`; the subject here
          // is the RESOLUTION of the ref into `blockedByNodeIds`.
          patch: { blockedByAdd: [`planItem:${addId}`] },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    // THE assertion: the edge the plan proposes, as the canvas reads it —
    // blocker → blocked, resolved to NODE ids, de-duplicated.
    expect(modify.blockedByNodeIds).toEqual([add.nodeId]);
    // …and both ends sit on the same level, so `mergePlanLevel` can draw it.
    expect(add.parentNodeId).toBe(story.id);
    expect(modify.parentNodeId).toBe(story.id);
    // The `links` diff row is a SECOND reader of the patch, not a move of the
    // first: it counts the patch's REFS, while `blockedByNodeIds` is what will
    // be DRAWN. The two still answer separately — they simply agree at one now
    // that a duplicate can no longer be appended (MOTIR-3573), so the count the
    // diff row reports is the count the plan actually wrote.
    expect(modify.changes).toContainEqual({ field: 'links', from: null, to: '+1 blocker' });
  });

  it('follows the node id an approved `add` BECAME — the edge survives materialize (MOTIR-3366)', async () => {
    // The intra-plan temp-ref resolves to the referenced item's NODE id, which
    // moves from the plan-item id to the created work item's at approve
    // (MOTIR-3160). An edge that resolved to the pre-approval id would point at
    // a node that is no longer on the canvas.
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'Offboarding');
    const inFlight = await seedChild(fx, 'task', 'Reach the live worker', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Approve me' }, fx.ctx);
    const afterAdd = await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: story.id, proposedFields: { title: 'The orchestrator port' } }],
      fx.ctx,
    );
    const addId = afterAdd.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: inFlight.id, patch: { blockedByAdd: [`planItem:${addId}`] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const approved = await plansService.approvePlan(plan.id, fx.ctx);
    const createdId = approved.items.find((i) => i.op === 'add')!.workItemId;

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const add = review.items.find((i) => i.op === 'add')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    expect(createdId).not.toBeNull();
    expect(add.nodeId).toBe(createdId);
    expect(add.nodeId).not.toBe(add.planItemId);
    expect(modify.blockedByNodeIds).toEqual([createdId]);
  });

  it('still resolves an ADD’s OWN `blockedByRefs` — the carrier that always worked (MOTIR-3366)', async () => {
    // The control. A committed blocker stays as-is, an intra-plan one resolves
    // to that proposal's node id, and the two carriers do not interfere.
    const fx = await makeWorkItemFixture();
    const story = await seedChild(fx, 'story', 'Incremental indexing');
    const committed = await seedChild(fx, 'task', 'The decision', story.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Two blockers' }, fx.ctx);
    const afterFirst = await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: story.id, proposedFields: { title: 'The measurement' } }],
      fx.ctx,
    );
    const firstId = afterFirst.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: story.id,
          blockedByRefs: [committed.id, `planItem:${firstId}`],
          proposedFields: { title: 'The worker' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const first = review.items.find((i) => i.planItemId === firstId)!;
    const second = review.items.find((i) => i.planItemId !== firstId)!;

    expect(second.blockedByNodeIds).toEqual([committed.id, first.nodeId]);
    // Nothing was added to the proposal that carries no edges at all.
    expect(first.blockedByNodeIds).toEqual([]);
  });

  it('renders a description change as a DIFF of the live and proposed bodies, previewed (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card whose body moved');
    await adminDb.workItem.update({
      where: { id: target.id },
      data: { descriptionMd: '# Before\n\nThe body   as first   planned.' },
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Rewrite plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { descriptionMd: '# After\n\nThe body the re-scope leaves behind.' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    // Whitespace squeezed (a body is multi-paragraph, the cell is one line), and
    // the ACTUAL values on both sides — this cell used to read `— → updated`.
    expect(review.items[0]!.changes.find((c) => c.field === 'description')).toEqual({
      field: 'description',
      from: '# Before The body as first planned.',
      to: '# After The body the re-scope leaves behind.',
    });
  });

  it('CAPS each side of a prose diff so a long body cannot ride the wire whole (MOTIR-3191)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seedItem(fx, 'Card with a long body');
    const long = 'x'.repeat(400);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Long plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { descriptionMd: long } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const change = review.items[0]!.changes.find((c) => c.field === 'description')!;
    // 140 characters, the last of them the ellipsis that says so.
    expect(change.to).toHaveLength(140);
    expect(change.to!.endsWith('…')).toBe(true);
    // Nothing there before ⇒ the old side is null, not an empty string.
    expect(change.from).toBeNull();
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
    expect(lifecycleKinds(review.history)).toEqual(['created', 'planned', 'declined']);
    // MOTIR-3189 — a plan a person read and rejected keeps the `declined` event
    // and the original wording. It is the OTHER two endings that had to change.
    expect(review.decisionReason).toBe('reviewed');

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

  // MOTIR-3189 — `declined` covers three histories, and until this card the
  // service pushed ONE `declined` event for all of them, so the rail rendered a
  // plan that died halfway through generating exactly like one somebody read and
  // rejected: you could see that it ended, not why. The reason is a private
  // column rather than a fourth `PlanStatus` member (AMENDMENT 6), so the
  // TIMELINE is where the difference has to become visible.
  describe('the timeline distinguishes the three endings (MOTIR-3189)', () => {
    /** A `generating` plan holding one proposal — the shape a crashed generation
     *  or an abandoned authoring pass leaves. Deliberately not `markPlanned`ed,
     *  which is what keeps `plannedAt` null. */
    async function halfWritten(fx: WorkItemFixture): Promise<string> {
      const plan = await plansService.createPlan(fx.projectId, { title: 'Half' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Got this far', kind: 'task' } }],
        fx.ctx,
      );
      return plan.id;
    }

    it('a DISCARDED plan reads `discarded`, and has no `planned` event at all', async () => {
      const fx = await makeWorkItemFixture();
      const planId = await halfWritten(fx);
      await plansService.declinePlan(planId, fx.ctx);

      const review = await planReviewService.getPlanReview(planId, fx.ctx);

      // No `planned` event: the generation frontier never closed, and the
      // timeline says so by ABSENCE rather than by a back-filled timestamp.
      expect(lifecycleKinds(review.history)).toEqual(['created', 'discarded']);
      expect(review.plannedAt).toBeNull();
      expect(review.decisionReason).toBe('discarded');
      // A PERSON discarded it, so the decider is named — which is exactly what
      // separates this ending from the sweep's.
      expect(review.history.at(-1)!.byName).not.toBeNull();
      // And the proposal it managed to produce survives to be read.
      expect(review.itemCount).toBe(1);
      expect(review.items).toHaveLength(1);
    });

    it('an ABANDONED plan reads `abandoned`, with NOBODY named', async () => {
      // The sweep's ending. It writes `decisionReason: 'abandoned'` and leaves
      // `decidedById` null, so the row is the one case where a decision event
      // carries no actor — the surface must not render it as a person's call.
      const fx = await makeWorkItemFixture();
      const planId = await halfWritten(fx);
      await adminDb.plan.update({
        where: { id: planId },
        data: { status: 'declined', decidedAt: new Date(), decisionReason: 'abandoned' },
      });

      const review = await planReviewService.getPlanReview(planId, fx.ctx);

      expect(lifecycleKinds(review.history)).toEqual(['created', 'abandoned']);
      expect(review.decisionReason).toBe('abandoned');
      expect(review.decidedByName).toBeNull();
      expect(review.history.at(-1)!.byName).toBeNull();
    });

    it('a `declined` row with NO recorded reason keeps the ORIGINAL event — a null is not a fourth ending', async () => {
      // Every row written before the column existed. `null` means *not
      // recorded*, and the pre-column wording is the one that was true for
      // those plans, so the timeline must fall back rather than guess.
      const fx = await makeWorkItemFixture();
      const plan = await plansService.createPlan(fx.projectId, { title: 'Legacy' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Old', kind: 'task' } }],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      await adminDb.plan.update({
        where: { id: plan.id },
        data: { status: 'declined', decidedAt: new Date(), decisionReason: null },
      });

      const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

      expect(review.decisionReason).toBeNull();
      expect(lifecycleKinds(review.history)).toEqual(['created', 'planned', 'declined']);
    });

    it('an APPROVED plan carries no reason — an approval has one history', async () => {
      const fx = await makeWorkItemFixture();
      const plan = await plansService.createPlan(fx.projectId, { title: 'Yes' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Built', kind: 'task' } }],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      await plansService.approvePlan(plan.id, fx.ctx);

      const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

      expect(lifecycleKinds(review.history)).toEqual(['created', 'planned', 'approved']);
      expect(review.decisionReason).toBeNull();
    });
  });

  it('throws PlanNotFoundError for a missing plan', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      planReviewService.getPlanReview('plan_does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});
