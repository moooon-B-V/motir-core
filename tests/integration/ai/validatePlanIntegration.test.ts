import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { POST as validatePlanPOST } from '@/app/api/internal/ai/validate-plan/route';
import { POST as validatePlanSprintPOST } from '@/app/api/internal/ai/validate-plan-sprint/route';
import type { WorkItemValidityDto } from '@/lib/dto/workItems';
import type { SprintValidityDto } from '@/lib/dto/sprints';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// STORY-LEVEL INTEGRATION TEST (Subtask 7.28.5 / MOTIR-1389), real Postgres.
// One seed + ONE Plan exercising EVERY op (add with a `planItem:<id>` temp-ref
// parent + an out-of-subtree blocker, modify adding a blocked_by edge from an
// in-sprint item to a new backlog add, and remove) drives the engine + both
// endpoints end-to-end, and — critically — proves the PROJECTION verdict equals
// the POST-materialize `validate_work_item` / `validate_sprint` verdict (the
// projection==materialize contract from 7.28.1).

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'story' | 'task' | 'subtask',
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);

const putInSprint = (id: string, sprintId: string) =>
  db.workItem.update({ where: { id }, data: { sprintId } });

const markDone = (id: string) => db.workItem.update({ where: { id }, data: { status: 'done' } });

function validateReq(path: string, fx: WorkItemFixture, body: unknown): Request {
  return new Request(`http://core${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SERVICE_SECRET}`,
      'x-motir-job-token': mintJobToken({
        userId: fx.ctx.userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    },
    body: JSON.stringify(body),
  });
}

describe('pre-commit plan validation — engine + endpoints + projection==materialize', () => {
  it('validates a multi-op plan over both endpoints and matches the post-materialize verdict', async () => {
    const fx = await makeWorkItemFixture();

    // ── Seed: a real subtree + an active sprint + out-of-subtree blockers ────────
    const story = await mk(fx, 'Target story', 'story'); // the validate-plan target
    await mk(fx, 'Existing child', 'subtask', story.id);
    const outsideNotDone = await mk(fx, 'Outside not-done', 'task'); // gates under loose+tight
    const outsideDone = await mk(fx, 'Outside done', 'task'); // gates only under tight
    await markDone(outsideDone.id);

    const sprintId = (await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx)).id;
    await sprintsService.startSprint(sprintId, {}, fx.ctx);
    const inSprint = await mk(fx, 'In-sprint item', 'task');
    const toRemove = await mk(fx, 'Sprint item to remove', 'task');
    await putInSprint(inSprint.id, sprintId);
    await putInSprint(toRemove.id, sprintId);

    // ── ONE Plan exercising every op, built in stages to capture temp-refs ───────
    const plan = await plansService.createPlan(fx.projectId, { title: 'Big plan' }, fx.ctx);
    // add A — a child UNDER the target story, itself blocked_by a DONE outside item.
    const afterA = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Add A', kind: 'task' },
          parentRef: story.id,
          blockedByRefs: [outsideDone.id],
        },
      ],
      fx.ctx,
    );
    const aId = afterA.items.find((i) => i.proposedFields?.title === 'Add A')!.id;
    // add C — a brand-new BACKLOG item the in-sprint modify will depend on.
    const afterC = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Add C backlog', kind: 'task' } }],
      fx.ctx,
    );
    const cId = afterC.items.find((i) => i.proposedFields?.title === 'Add C backlog')!.id;
    // add B — UNDER add A (temp-ref parent), blocked_by a NOT-DONE outside item.
    const afterB = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Add B', kind: 'subtask' },
          parentRef: `planItem:${aId}`,
          blockedByRefs: [outsideNotDone.id],
        },
      ],
      fx.ctx,
    );
    const bId = afterB.items.find((i) => i.proposedFields?.title === 'Add B')!.id;
    // modify — make the in-sprint item blocked_by the new backlog add C.
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: inSprint.id, patch: { blockedByAdd: [`planItem:${cId}`] } }],
      fx.ctx,
    );
    // remove — drop a sprint member.
    await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: toRemove.id }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    // ── validate-plan (work item) over the REAL route — LOOSE then TIGHT ─────────
    const looseRes = await validatePlanPOST(
      validateReq('/api/internal/ai/validate-plan', fx, {
        planId: plan.id,
        targetKey: story.identifier,
      }),
    );
    expect(looseRes.status).toBe(200);
    const loose = (await looseRes.json()) as WorkItemValidityDto;
    // Under loose: only B's not-done outside blocker gates (A's done blocker is OK).
    expect(loose.valid).toBe(false);
    expect(loose.blockers).toEqual([
      {
        item: `planItem:${bId}`,
        blockedBy: outsideNotDone.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    const tightRes = await validatePlanPOST(
      validateReq('/api/internal/ai/validate-plan', fx, {
        planId: plan.id,
        targetKey: story.identifier,
        condition: 'tight',
      }),
    );
    const tight = (await tightRes.json()) as WorkItemValidityDto;
    // Under tight: BOTH the done and not-done outside blockers gate (2 rows).
    expect(tight.valid).toBe(false);
    expect(tight.blockers).toHaveLength(2);
    expect(tight.blockers.map((b) => b.blockedBy).sort()).toEqual(
      [outsideDone.identifier, outsideNotDone.identifier].sort(),
    );

    // ── validate-plan-sprint over the REAL route ─────────────────────────────────
    const sprintRes = await validatePlanSprintPOST(
      validateReq('/api/internal/ai/validate-plan-sprint', fx, { planId: plan.id }),
    );
    expect(sprintRes.status).toBe(200);
    const sprintVerdict = (await sprintRes.json()) as SprintValidityDto;
    // The in-sprint item is flagged by the modify→new-backlog-add edge (a temp-ref
    // blocker); the removed item is gone, so it never appears.
    expect(sprintVerdict.sprintId).toBe(sprintId);
    expect(sprintVerdict.valid).toBe(false);
    expect(sprintVerdict.blockers).toEqual([
      {
        item: inSprint.identifier,
        blockedBy: `planItem:${cId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    // ── EQUIVALENCE: materialize the SAME plan, then validate the real result ────
    await plansService.approvePlan(plan.id, fx.ctx);

    const materializedWi = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    // Same VERDICT as the pre-commit projection (the temp-ref gated items are now
    // real keys, so the verdict + the stable real blocker names match).
    expect(materializedWi.valid).toBe(loose.valid);
    expect(materializedWi.blockers).toHaveLength(loose.blockers.length);
    expect(materializedWi.blockers[0]?.blockedBy).toBe(outsideNotDone.identifier);

    const materializedTight = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(materializedTight.valid).toBe(tight.valid);
    expect(materializedTight.blockers).toHaveLength(tight.blockers.length);

    const materializedSprint = await sprintsService.validateSprint(fx.projectId, null, fx.ctx);
    expect(materializedSprint.valid).toBe(sprintVerdict.valid);
    expect(materializedSprint.blockers).toHaveLength(sprintVerdict.blockers.length);
    expect(materializedSprint.blockers[0]?.item).toBe(inSprint.identifier);
  });
});
