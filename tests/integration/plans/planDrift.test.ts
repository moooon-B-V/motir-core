import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planDriftService } from '@/lib/services/planDriftService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planRepository } from '@/lib/repositories/planRepository';
import { PlanNotInExpectedStatusError, PlanTargetImmutableError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// WHO MOVES A PLAN BETWEEN `planned` AND `stale` (Bug MOTIR-3560 · Subtask
// MOTIR-3579), implementing `docs/decisions/agent-authored-plans.md`
// AMENDMENT 9 D4/D5 over real Postgres.
//
// The wiring — that anything calls this at all — is `tests/jobs/plan-drift.test.ts`.
// This file is the BEHAVIOUR, and almost every case below is about RESTRAINT
// rather than about the happy path: the service runs on every status change in
// the tenant, so what matters is which plans it leaves alone, that it never
// throws, and that it loses a race quietly.

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const DONE = { fromStatusKey: 'in_progress', toStatusKey: 'done' };
const REVIVE = { fromStatusKey: 'done', toStatusKey: 'in_progress' };

async function seed(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

/** A `planned` plan proposing to `modify` each of `targets`. */
async function plannedPlanTargeting(fx: WorkItemFixture, targets: string[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Rework' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    targets.map((workItemId) => ({ op: 'modify' as const, workItemId, patch: { title: 'New' } })),
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function statusOf(planId: string): Promise<string> {
  return (await adminDb.plan.findUnique({ where: { id: planId } }))!.status;
}

/** Move a work item's status directly — the transition itself is not the
 *  subject here, only what the listener does with the event it produces. */
async function setStatus(workItemId: string, statusKey: string): Promise<void> {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status: statusKey } });
}

describe('INTO `stale` — a target finished under a plan that proposes to change it', () => {
  it('moves a `planned` plan holding a `modify` on the item', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Settings pane');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'done');

    const out = await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);

    expect(out.markedStale).toEqual([planId]);
    expect(await statusOf(planId)).toBe('stale');
  });

  it('fires for `cancelled` too — terminal is a CATEGORY, never a hardcoded `done`', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Dropped work');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'cancelled');

    const out = await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, {
      fromStatusKey: 'in_progress',
      toStatusKey: 'cancelled',
    });

    // Resolved through `workflowsService.getTerminalStatusKeys` for the PLAN's
    // project, so every `category = 'done'` status triggers it. A hardcoded
    // `'done'` would leave a cancelled target silently un-flagged.
    expect(out.markedStale).toEqual([planId]);
  });

  it('does NOTHING for a move that is not an ENTRY — the trigger is the TRANSITION', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Already finished');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'cancelled');

    // `done → cancelled`: terminal before AND after. Approvability did not
    // change, and a consumer keyed on the resulting STATE rather than on the
    // transition would re-fire on every later observation of it.
    const out = await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, {
      fromStatusKey: 'done',
      toStatusKey: 'cancelled',
    });

    expect(out.markedStale).toEqual([]);
    expect(await statusOf(planId)).toBe('planned');
  });

  it('leaves a plan in ANY other status alone', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Target');
    const generating = await plansService.createPlan(fx.projectId, { title: 'Draft' }, fx.ctx);
    await plansService.addProposals(
      generating.id,
      [{ op: 'modify', workItemId: target, patch: { title: 'New' } }],
      fx.ctx,
    );
    const declined = await plannedPlanTargeting(fx, [target]);
    await plansService.declinePlan(declined, fx.ctx);
    await setStatus(target, 'done');

    const out = await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);

    // A `generating` plan is in front of nobody and has nothing to be stale
    // about; a decided one is over. `stale` is reachable ONLY from `planned`.
    expect(out.markedStale).toEqual([]);
    expect(await statusOf(generating.id)).toBe('generating');
    expect(await statusOf(declined)).toBe('declined');
  });

  it('ignores a plan that only `add`s — an add has no target to have finished', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Unrelated');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Additive' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Brand new', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await setStatus(target, 'done');

    const out = await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);

    expect(out.markedStale).toEqual([]);
    expect(await statusOf(plan.id)).toBe('planned');
  });

  it('is a SILENT NO-OP when the plan moved under the lock — it loses the race safely', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Contended');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'done');

    // The work item's transition and the plan's are two writes, so a reviewer
    // can decide the plan between this listener's read and its write. The
    // lock-then-re-read is what makes that a no-op rather than an overwrite of
    // somebody's decision — declining a plan and then finding it `stale` would
    // be strictly worse than doing nothing.
    const real = planRepository.findById.bind(planRepository);
    let armed = true;
    vi.spyOn(planRepository, 'findById').mockImplementation(async (...args) => {
      const row = await real(...(args as Parameters<typeof real>));
      if (armed) {
        armed = false;
        await plansService.declinePlan(planId, fx.ctx);
      }
      return row;
    });

    const out = await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);

    expect(out.markedStale).toEqual([]);
    expect(await statusOf(planId)).toBe('declined');
  });

  it('NEVER THROWS for a business reason — a missing plan is skipped, not an error', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Ghost');
    const planId = await plannedPlanTargeting(fx, [target]);
    // The proposal outlives its plan only if somebody deletes the plan row; the
    // point is the shape — this runs AFTER a status change the user already made
    // successfully, so nothing here may fail that transition or its job.
    await adminDb.planItem.updateMany({ where: { planId }, data: { planId } });
    await adminDb.plan.delete({ where: { id: planId } });

    await expect(
      planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE),
    ).resolves.toBeTruthy();
  });
});

describe('BACK to `planned` — the drift REVERSES', () => {
  it('restores a plan whose only terminal target revived', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Reopened');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'done');
    await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);
    expect(await statusOf(planId)).toBe('stale');

    await setStatus(target, 'in_progress');
    const out = await planDriftService.restoreForRevivedTarget(target, fx.workspaceId, REVIVE);

    // `done → in_progress` is a legal work-item transition, so a plan's premise
    // can come back — and without this edge a plan is punished permanently for a
    // target that was closed for an hour. This is why the drift case earns a
    // STATUS rather than a flag.
    expect(out.restored).toEqual([planId]);
    expect(await statusOf(planId)).toBe('planned');
  });

  it('does NOT restore while a SECOND target is still terminal', async () => {
    const fx = await makeWorkItemFixture();
    const first = await seed(fx, 'First');
    const second = await seed(fx, 'Second');
    const planId = await plannedPlanTargeting(fx, [first, second]);
    await setStatus(first, 'done');
    await setStatus(second, 'done');
    await planDriftService.markStaleForTerminalTarget(first, fx.workspaceId, DONE);
    expect(await statusOf(planId)).toBe('stale');

    await setStatus(first, 'in_progress');
    const out = await planDriftService.restoreForRevivedTarget(first, fx.workspaceId, REVIVE);

    // ⚠️ IT IS *EVERY* TARGET, NOT THE ONE THAT MOVED. `approvePlan`'s gate
    // would still refuse this plan over `second`, so restoring it here would put
    // it back in the queue wearing `planned` — the exact lie this container
    // exists to remove.
    expect(out.restored).toEqual([]);
    expect(await statusOf(planId)).toBe('stale');

    // …and when the second one revives too, it comes back.
    await setStatus(second, 'in_progress');
    const after = await planDriftService.restoreForRevivedTarget(second, fx.workspaceId, REVIVE);
    expect(after.restored).toEqual([planId]);
    expect(await statusOf(planId)).toBe('planned');
  });

  it('does NOTHING for a move that is not an EXIT', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Target');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'done');
    await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);

    // `todo → in_progress`: non-terminal on both sides, so nothing about this
    // plan's approvability changed.
    const out = await planDriftService.restoreForRevivedTarget(target, fx.workspaceId, {
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });

    expect(out.restored).toEqual([]);
    expect(await statusOf(planId)).toBe('stale');
  });

  it('leaves a `planned` plan alone — restore is not a way INTO `planned`', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Target');
    const planId = await plannedPlanTargeting(fx, [target]);

    const out = await planDriftService.restoreForRevivedTarget(target, fx.workspaceId, REVIVE);

    expect(out.restored).toEqual([]);
    expect(await statusOf(planId)).toBe('planned');
  });
});

describe('the LAZY backstop — one button press never leaves the plan worse', () => {
  it('approve REFUSES and the plan is left `stale`, not `planned`', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Finished under it');
    const planId = await plannedPlanTargeting(fx, [target]);
    // The drift arrives WITHOUT the listener having run — which is exactly the
    // race the backstop exists for.
    await setStatus(target, 'done');

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanTargetImmutableError,
    );

    // BOTH halves in one assertion pair: the caller still gets its refusal (the
    // route still answers 409), and what changed is what the plan row READS
    // afterwards. Before this the plan sat at `planned`, unapprovable, with the
    // reviewer told only that their click failed.
    expect(await statusOf(planId)).toBe('stale');
  });

  it('materializes NOTHING on that refusal — the tree is untouched', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Finished under it');
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'done');

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toThrow();

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });
});

describe('the exits from `stale`', () => {
  it('DECLINE accepts it, and records `reviewed` — the plan DID reach a reviewer', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Target');
    const planId = await plannedPlanTargeting(fx, [target]);
    await setStatus(target, 'done');
    await planDriftService.markStaleForTerminalTarget(target, fx.workspaceId, DONE);

    await plansService.declinePlan(planId, fx.ctx);

    const row = (await adminDb.plan.findUnique({ where: { id: planId } }))!;
    expect(row.status).toBe('declined');
    // `discarded` is for a plan that never finished being written; this one did,
    // and the drift is why the reviewer gave up rather than a different kind of
    // ending (AMENDMENT 9 D4).
    expect(row.decisionReason).toBe('reviewed');
  });

  it('APPROVE still refuses it — the only exits are decline, or the drift reversing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Target');
    const planId = await plannedPlanTargeting(fx, [target]);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );
  });

  it('`addProposals` still refuses it — there is NO edge back to `generating`', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'Target');
    const planId = await plannedPlanTargeting(fx, [target]);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });

    // ⚠️ THE FOURTH EDGE IS DELIBERATELY ABSENT (AMENDMENT 9 D4). MOTIR-3560
    // proposed `stale → generating` — *the author repairs it* — and the
    // amendment ruled it out. `correctProposal` / `withdrawProposal` have since
    // shipped (AMENDMENT 8, MOTIR-3540), so the capability now exists and the
    // remaining question is whether `assertPlanProposalsEditable` should admit
    // `stale`; D4 records that as a decision for its own card rather than one to
    // smuggle in here, because it changes what a `planned` plan's frozen
    // proposal set means.
    await expect(
      plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'A repair', kind: 'task' } }],
        fx.ctx,
      ),
    ).rejects.toThrow();
  });
});
