import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { PlanNotFoundError } from '@/lib/plans/errors';
import type { PlanItemStalenessDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Integration tests for Subtask 7.21.3 / MOTIR-1340 — `planStalenessService`,
// plan staleness detection (Story 7.21). Real Postgres (no mocks), per CLAUDE.md.
// Proves the rule set over a fixture for EACH reason:
//   • parent_removed   — a proposed add's real parent archived after plannedAt;
//   • blocker_removed  — a real blocked_by target of the add archived;
//   • base_revision_drift — a modify/remove target edited (latest revision id
//                        moved off the proposal's baseRevision) or archived.
// Plus: an unchanged tree returns all-clear; the service is a PURE read (writes
// nothing, never blocks); and it is tenant-scoped (404-not-403 cross-tenant).
//
// ⚠️ AND ONE NEGATIVE, which is the whole of MOTIR-3777: an `add` that declared
// NO edges is all-clear however many unrelated cards land under its parent. The
// retired `siblings_added` rule asserted the opposite here, and it was the only
// rule keyed on something the proposal had not named.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Seed a work item through the real service (so it carries a valid fractional
 *  `position`/`backlogRank` AND a `created` revision). */
async function seed(
  fx: WorkItemFixture,
  title: string,
  kind: 'story' | 'task' | 'subtask' = 'task',
  parentId: string | null = null,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

/** The target's CURRENT latest revision id — the optimistic-concurrency anchor
 *  a producer would store as a modify/remove proposal's `baseRevision`. */
async function latestRev(workItemId: string, workspaceId: string): Promise<string> {
  const map = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRevisionRepository.findLatestIdsByWorkItemIds([workItemId], tx),
  );
  const rev = map.get(workItemId);
  if (!rev) throw new Error(`no revision for ${workItemId}`);
  return rev;
}

/** Create a plan, append proposals, mark it `planned`; return the plan id + the
 *  appended items (so a test can map a verdict back by `planItemId`). */
async function plannedPlan(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  const withItems = await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, items: withItems.items };
}

function verdictFor(items: PlanItemStalenessDto[], planItemId: string): PlanItemStalenessDto {
  const v = items.find((i) => i.planItemId === planItemId);
  if (!v) throw new Error(`no verdict for plan item ${planItemId}`);
  return v;
}

describe('planStalenessService — per-reason detection', () => {
  it('parent_removed: a proposed add whose real parent is archived after plannedAt', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Parent story', 'story');
    const { planId, items } = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Child', kind: 'subtask' }, parentRef: parentId },
    ]);

    // The committed tree changes after planning: the parent is archived.
    await workItemsService.archiveWorkItem(parentId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(result.stale).toBe(true);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.stale).toBe(true);
    expect(v.reasons).toEqual([{ code: 'parent_removed', parentId }]);
  });

  // ── MOTIR-3777 — an EDGE-LESS `add` is not stale because its parent is busy ──
  //
  // The regression this card exists for. `siblingsAddedRule` asked one question —
  // *did this parent gain a live child after `plannedAt`?* — and never read the
  // sibling: not its kind, not its subject, not its edges. Its one excuse clause
  // (`.filter((c) => !declaredBlockers.has(c.id))`) was unreachable on the
  // generation path, because a proposal cannot name an id that did not exist when
  // it was written and `findChildrenCreatedAfter` returns only ids younger than
  // `plannedAt`. So on a busy parent the badge measured how busy the parent was.
  //
  // The predicate is now the one the reviewer already reasons with: a proposal is
  // out of date when something IT NAMED has moved. A proposal that named nothing
  // is self-contained.
  it('an add with NO declared edges is all-clear however many unrelated siblings land under its parent', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Busy epic', 'story');
    const { planId, items } = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed child', kind: 'subtask' },
        parentRef: parentId,
        // The shape of the live reproduction: no dependency edge at all.
        blockedByRefs: [],
      },
    ]);

    // Three unrelated cards land under the same parent after the plan was
    // generated — the production fixture exactly (MOTIR-653 gained three
    // out-of-band dogfooding bugs within four hours of the plan being drafted).
    await seed(fx, 'Unrelated bug 1', 'subtask', parentId);
    await seed(fx, 'Unrelated bug 2', 'subtask', parentId);
    await seed(fx, 'Unrelated bug 3', 'subtask', parentId);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.reasons).toEqual([]);
    expect(v.stale).toBe(false);
    expect(result.stale).toBe(false);
  });

  it('blocker_removed: a real blocked_by target of the add is archived', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seed(fx, 'Blocker');
    const { planId, items } = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Blocked add', kind: 'task' },
        blockedByRefs: [blockerId],
      },
    ]);

    await workItemsService.archiveWorkItem(blockerId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.stale).toBe(true);
    expect(v.reasons).toEqual([{ code: 'blocker_removed', blockerIds: [blockerId] }]);
  });

  it('base_revision_drift (edited): a modify target changed since the proposal baseRevision', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seed(fx, 'Original title');
    const baseRevision = await latestRev(targetId, fx.workspaceId);
    const { planId, items } = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'Proposed title' }, baseRevision },
    ]);

    // Someone edits the target after the plan was generated → a new revision.
    await workItemsService.updateWorkItem(targetId, { title: 'Edited out-of-band' }, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.workItemId).toBe(targetId);
    expect(v.reasons).toEqual([{ code: 'base_revision_drift', change: 'edited' }]);
  });

  it('base_revision_drift (archived): a remove target archived after planning counts as removed', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seed(fx, 'To be removed');
    const baseRevision = await latestRev(targetId, fx.workspaceId);
    const { planId, items } = await plannedPlan(fx, [
      { op: 'remove', workItemId: targetId, baseRevision },
    ]);

    await workItemsService.archiveWorkItem(targetId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.reasons).toEqual([{ code: 'base_revision_drift', change: 'archived' }]);
  });

  it('multi-reason: one proposed add accumulates parent_removed AND blocker_removed', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Parent story', 'story');
    const blockerId = await seed(fx, 'Blocker');
    const { planId, items } = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Child', kind: 'subtask' },
        parentRef: parentId,
        blockedByRefs: [blockerId],
      },
    ]);

    // BOTH the proposal's real parent AND its real blocker are archived after
    // planning — two independent rules fire on the SAME PlanItem.
    await workItemsService.archiveWorkItem(parentId, fx.ctx);
    await workItemsService.archiveWorkItem(blockerId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(result.stale).toBe(true);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.stale).toBe(true);
    // The verdict is a REASON LIST, not a boolean: a single item carries BOTH
    // reasons, concatenated in the fixed `RULES` order (parent_removed before
    // blocker_removed).
    expect(v.reasons).toEqual([
      { code: 'parent_removed', parentId },
      { code: 'blocker_removed', blockerIds: [blockerId] },
    ]);
  });
});

describe('planStalenessService — all-clear + purity + tenancy', () => {
  it('returns all-clear when the tree is unchanged since plannedAt', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Parent', 'story');
    const blockerId = await seed(fx, 'Blocker');
    const targetId = await seed(fx, 'Target');
    const baseRevision = await latestRev(targetId, fx.workspaceId);

    const { planId, items } = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'New child', kind: 'subtask' },
        parentRef: parentId,
        blockedByRefs: [blockerId],
      },
      { op: 'modify', workItemId: targetId, patch: { title: 'Renamed' }, baseRevision },
    ]);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(result.stale).toBe(false);
    for (const item of items) {
      expect(verdictFor(result.items, item.id).reasons).toEqual([]);
    }
  });

  it('is a PURE read — computing staleness writes nothing and never decides the plan', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seed(fx, 'Edited');
    const baseRevision = await latestRev(targetId, fx.workspaceId);
    const { planId } = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'X' }, baseRevision },
    ]);
    await workItemsService.updateWorkItem(targetId, { title: 'Moved on' }, fx.ctx);

    const revsBefore = await adminDb.workItemRevision.count();
    const itemsBefore = await adminDb.workItem.count();

    // Compute twice — a pure read is idempotent and side-effect-free.
    const a = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const b = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(a).toEqual(b);
    expect(a.stale).toBe(true); // it WARNS …

    // … but changes nothing: no revisions/items written, plan still `planned`.
    const workItemRevisionCount = await adminDb.workItemRevision.count();
    expect(workItemRevisionCount).toBe(revsBefore);
    const workItemCount = await adminDb.workItem.count();
    expect(workItemCount).toBe(itemsBefore);
    expect((await plansService.getPlan(planId, fx.ctx)).status).toBe('planned');
  });

  it('a plan in another workspace is a 404 (PlanNotFoundError), not a 403 — cross-tenant guard', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const other = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLBX' });
    const { planId } = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Theirs', kind: 'task' } },
    ]);

    await expect(
      planStalenessService.computePlanStaleness(planId, other.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);

    await expect(
      planStalenessService.computePlanStaleness('plan_does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  // ── MOTIR-3165 (bug MOTIR-3154) — a DECIDED plan is never stale ───────────
  //
  // Staleness answers exactly one question: *would approving this now still be
  // correct?* `approvePlan` and `declinePlan` each refuse unless the plan is
  // `planned`, so on a decided plan that question cannot be asked again and
  // every warning is advice about a choice nobody can make.
  //
  // Worse than useless, in fact: the warning an approved plan showed was CAUSED
  // by the approval. The retired `siblings_added` rule (MOTIR-3777) read the
  // parent's post-`plannedAt` children with no exclusion for the items the plan
  // itself materialized, and `isRealRef` drops every intra-plan `planItem:` edge,
  // so N proposals under one committed parent each saw the other N−1 as
  // unexplained new siblings. The status guard below is what MOTIR-3165 added and
  // is untouched; the rule that produced the noise is now gone one layer in, so
  // this case would pass on its own — which is exactly why it stays. It asserts
  // the GUARD, and a guard is not proven by a rule set that happens to be quiet.

  it('an APPROVED plan is all-clear — its own materialized siblings do not flag it', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Shared parent', 'story');
    const { planId, items } = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'First child', kind: 'subtask' }, parentRef: parentId },
      {
        op: 'add',
        proposedFields: { title: 'Second child', kind: 'subtask' },
        parentRef: parentId,
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);

    expect(result.stale).toBe(false);
    for (const item of items) {
      expect(verdictFor(result.items, item.id).reasons).toEqual([]);
      expect(verdictFor(result.items, item.id).stale).toBe(false);
    }
  });

  it('a DECLINED plan is all-clear too — nothing was decided that can be re-decided', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Doomed parent', 'story');
    const { planId, items } = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Refused', kind: 'subtask' }, parentRef: parentId },
    ]);

    await plansService.declinePlan(planId, fx.ctx);
    // A change that WOULD flag a `planned` plan lands after the decision.
    await workItemsService.archiveWorkItem(parentId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);

    expect(result.stale).toBe(false);
    expect(verdictFor(result.items, items[0]!.id).reasons).toEqual([]);
  });

  // Re-expressed for MOTIR-3777 (AC5): this case guards MOTIR-3165's STATUS
  // boundary — an undecided plan still gets a verdict — and it used to prove that
  // with `siblings_added`, the one reason MOTIR-3777 retired. The boundary is
  // unchanged, so the case survives on a reason that survives: the proposal's own
  // parent is archived, which a `planned` plan must still be told about.
  it('a plan still PLANNED is unaffected — the surviving rules fire exactly as before', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Live parent', 'story');
    const { planId, items } = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Child', kind: 'subtask' }, parentRef: parentId },
    ]);

    // A newcomer under the same parent — the drift that used to flag this plan,
    // and now must not — followed by the drift that genuinely does.
    await seed(fx, 'Newcomer', 'subtask', parentId);
    await workItemsService.archiveWorkItem(parentId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(result.stale).toBe(true);
    expect(verdictFor(result.items, items[0]!.id).reasons).toEqual([
      { code: 'parent_removed', parentId },
    ]);
  });

  it('the verdict NAMES the work item it is about, once the add has one', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, items } = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Becomes real', kind: 'task' } },
    ]);

    // Un-materialized: no target, so no id to name.
    const before = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(verdictFor(before.items, items[0]!.id).workItemId).toBeNull();

    await plansService.approvePlan(planId, fx.ctx);

    const created = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Becomes real' } });
    const after = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(verdictFor(after.items, items[0]!.id).workItemId).toBe(created.id);
  });

  it('tenant isolation: a change in ANOTHER tenant never flags this plan (workspace-scoped reads)', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLBX' });

    // Tenant A's plan: an add under A's parent, blocked by A's blocker — both
    // live, so on its own A's plan is all-clear.
    const aParent = await seed(a, 'A parent', 'story');
    const aBlocker = await seed(a, 'A blocker');
    const { planId, items } = await plannedPlan(a, [
      {
        op: 'add',
        proposedFields: { title: 'A child', kind: 'subtask' },
        parentRef: aParent,
        blockedByRefs: [aBlocker],
      },
    ]);

    // Tenant B independently makes, in ITS OWN tree, exactly the mutations that
    // WOULD flag staleness if they touched A's tree: a parent is archived. The
    // staleness reads are workspace-scoped (`findByIdsInWorkspace`), so none of
    // B's churn can leak into A's verdict.
    const bParent = await seed(b, 'B parent', 'story');
    await seed(b, 'B newcomer', 'subtask', bParent);
    await workItemsService.archiveWorkItem(bParent, b.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, a.ctx);
    expect(result.stale).toBe(false);
    expect(verdictFor(result.items, items[0]!.id).reasons).toEqual([]);
  });
});
