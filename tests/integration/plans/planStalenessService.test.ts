import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { PlanNotFoundError } from '@/lib/plans/errors';
import type { PlanItemStalenessDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Integration tests for Subtask 7.21.3 / MOTIR-1340 — `planStalenessService`,
// plan staleness detection (Story 7.21). Real Postgres (no mocks), per CLAUDE.md.
// Proves the rule set over a fixture for EACH reason:
//   • parent_removed   — a proposed add's real parent archived after plannedAt;
//   • siblings_added   — the parent gained a child after plannedAt the add has
//                        no dependency relation with;
//   • blocker_removed  — a real blocked_by target of the add archived;
//   • base_revision_drift — a modify/remove target edited (latest revision id
//                        moved off the proposal's baseRevision) or archived.
// Plus: an unchanged tree returns all-clear; the service is a PURE read (writes
// nothing, never blocks); and it is tenant-scoped (404-not-403 cross-tenant).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
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
async function latestRev(workItemId: string): Promise<string> {
  const map = await workItemRevisionRepository.findLatestIdsByWorkItemIds([workItemId]);
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

  it('siblings_added: the parent gained a child after plannedAt the add has no dependency relation with', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Parent story', 'story');
    const { planId, items } = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Proposed child', kind: 'subtask' },
        parentRef: parentId,
      },
    ]);

    // A NEW sibling lands under the same parent after the plan was generated.
    const newSibling = await seed(fx, 'Newcomer', 'subtask', parentId);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.stale).toBe(true);
    expect(v.reasons).toEqual([{ code: 'siblings_added', siblingIds: [newSibling] }]);
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
    const baseRevision = await latestRev(targetId);
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
    const baseRevision = await latestRev(targetId);
    const { planId, items } = await plannedPlan(fx, [
      { op: 'remove', workItemId: targetId, baseRevision },
    ]);

    await workItemsService.archiveWorkItem(targetId, fx.ctx);

    const result = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const v = verdictFor(result.items, items[0]!.id);
    expect(v.reasons).toEqual([{ code: 'base_revision_drift', change: 'archived' }]);
  });
});

describe('planStalenessService — all-clear + purity + tenancy', () => {
  it('returns all-clear when the tree is unchanged since plannedAt', async () => {
    const fx = await makeWorkItemFixture();
    const parentId = await seed(fx, 'Parent', 'story');
    const blockerId = await seed(fx, 'Blocker');
    const targetId = await seed(fx, 'Target');
    const baseRevision = await latestRev(targetId);

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
    const baseRevision = await latestRev(targetId);
    const { planId } = await plannedPlan(fx, [
      { op: 'modify', workItemId: targetId, patch: { title: 'X' }, baseRevision },
    ]);
    await workItemsService.updateWorkItem(targetId, { title: 'Moved on' }, fx.ctx);

    const revsBefore = await db.workItemRevision.count();
    const itemsBefore = await db.workItem.count();

    // Compute twice — a pure read is idempotent and side-effect-free.
    const a = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    const b = await planStalenessService.computePlanStaleness(planId, fx.ctx);
    expect(a).toEqual(b);
    expect(a.stale).toBe(true); // it WARNS …

    // … but changes nothing: no revisions/items written, plan still `planned`.
    expect(await db.workItemRevision.count()).toBe(revsBefore);
    expect(await db.workItem.count()).toBe(itemsBefore);
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
});
