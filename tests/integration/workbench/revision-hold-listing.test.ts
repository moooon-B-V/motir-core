import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { homeService } from '@/lib/services/homeService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workbenchPlanningService } from '@/lib/services/workbenchPlanningService';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import { runHoldPlanRevision } from '@/lib/mcp/tools/authorPlan';
import { PlanNotEditableError, PlanRevisionInFlightError } from '@/lib/plans/errors';
import { PLAN_REVISION_LEASE_MS } from '@/lib/planChange/revisionLease';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-7988 — a plan being REVISED after it was proposed is being planned
// again: it leaves Waiting on you for the Workbench's Planning tab while the
// revision lease is held, and comes back when the lease ends. Against real
// Postgres, through the product's own reads (the two lists, the strip's counts and
// the watermark) and through the MCP door an MCP-driven revision holds the plan by.

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (fx: WorkItemFixture) => ({ ...fx.ctx, projectId: fx.projectId });

/** A `planned` plan the owner asked for, carrying one `add` — so a gate is raised. */
async function plannedPlan(fx: WorkItemFixture, title = 'Revisable'): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title, authorSource: 'mcp', authorHarness: 'Claude Code', createdById: fx.ctx.userId },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: `${title} — the card`, kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

const hold = (fx: WorkItemFixture, planId: string, action: 'start' | 'renew' | 'end') =>
  runHoldPlanRevision({ planId, action, harness: 'Claude Code', model: 'opus' }, fx.ctx);

/** Where the plan is listed for its requester, read the way the Workbench reads it. */
async function listings(fx: WorkItemFixture, planId: string) {
  const [waiting, planning, counts, watermark] = await Promise.all([
    approvalGatesService.listAwaitingMe(me(fx)),
    workbenchPlanningService.listMyPlansBeingWritten(me(fx)),
    homeService.tabCounts(me(fx)),
    workbenchWatermarkService.read(me(fx)),
  ]);
  return {
    inWaiting: waiting.items.some(
      (row) => row.subject?.kind === 'plan_approval' && row.subject.planId === planId,
    ),
    waitingTotal: waiting.total,
    inPlanning: planning.items.some((row) => row.planId === planId),
    planningTotal: planning.total,
    counts: { approvals: counts.approvals, planning: counts.planning },
    watermarkApprovals: watermark.tabs.approvals.count,
  };
}

/** Age every trail row of the plan, as if its revision went silent `ms` ago. */
async function ageTrail(planId: string, ms: number) {
  const rows = await adminDb.planRevision.findMany({ where: { planId } });
  for (const row of rows) {
    await adminDb.planRevision.update({
      where: { id: row.id },
      data: { changedAt: new Date(row.changedAt.getTime() - ms) },
    });
  }
}

const gateState = async (planId: string) =>
  (
    await adminDb.approvalGate.findFirstOrThrow({
      where: { kind: 'plan_approval', subjectId: planId },
    })
  ).state;

describe('a plan with no revision in flight is unchanged — it waits on its requester', () => {
  it('is listed in Waiting on you and not under Planning', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    expect(await listings(fx, planId)).toEqual({
      inWaiting: true,
      waitingTotal: 1,
      inPlanning: false,
      planningTotal: 0,
      counts: { approvals: 1, planning: 0 },
      watermarkApprovals: 1,
    });
  });
});

describe('a HELD revision moves the plan from Waiting on you to Planning', () => {
  it('leaves every Waiting-on-you read and arrives in every Planning read, with progress', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);

    const started = await hold(fx, planId, 'start');
    expect(started.isError).toBeFalsy();
    expect(started.structuredContent).toMatchObject({ planId, action: 'start', held: true });

    expect(await listings(fx, planId)).toEqual({
      inWaiting: false,
      waitingTotal: 0,
      inPlanning: true,
      planningTotal: 1,
      counts: { approvals: 0, planning: 1 },
      watermarkApprovals: 0,
    });

    // The row carries a progress snapshot — a revised plan is read as one being
    // written, not dropped for want of one.
    const page = await workbenchPlanningService.listMyPlansBeingWritten(me(fx));
    expect(page.items[0]!.progress).toBeTruthy();

    // The plan's STATUS never moved, and its question is still asked — HELD, not withdrawn.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    expect(await gateState(planId)).toBe('awaiting');
  });

  it('refuses Approve and Decline with PLAN_REVISION_IN_FLIGHT while held, naming the harness', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await hold(fx, planId, 'start');

    const approve = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(approve).toBeInstanceOf(PlanRevisionInFlightError);
    expect((approve as PlanRevisionInFlightError).heldBy).toBe('Claude Code');
    await expect(plansService.declinePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanRevisionInFlightError,
    );
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('a second START is refused while the first holds the plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await hold(fx, planId, 'start');

    await expect(
      plansService.acquireRevisionLease(planId, fx.ctx, {
        source: 'mcp',
        harness: 'Another',
        model: null,
      }),
    ).rejects.toBeInstanceOf(PlanRevisionInFlightError);
  });

  it('only the plan a revision holds moves — a sibling plan stays in Waiting on you', async () => {
    const fx = await makeWorkItemFixture();
    const held = await plannedPlan(fx, 'Held');
    const waiting = await plannedPlan(fx, 'Waiting');
    await hold(fx, held, 'start');

    const heldAt = await listings(fx, held);
    const waitingAt = await listings(fx, waiting);
    expect(heldAt).toMatchObject({ inWaiting: false, inPlanning: true });
    expect(waitingAt).toMatchObject({ inWaiting: true, inPlanning: false });
    expect(heldAt.counts).toEqual({ approvals: 1, planning: 1 });
  });
});

describe('when the revision ENDS the plan is back in Waiting on you, and decidable', () => {
  it('on `end` — success or failure alike, the release is the same act', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await hold(fx, planId, 'start');

    const ended = await hold(fx, planId, 'end');
    expect(ended.structuredContent).toMatchObject({ planId, action: 'end', held: false });
    expect(await listings(fx, planId)).toMatchObject({
      inWaiting: true,
      inPlanning: false,
      counts: { approvals: 1, planning: 0 },
      watermarkApprovals: 1,
    });

    // `end` is idempotent: nobody holds it, so nothing is written.
    const before = await adminDb.planRevision.count({ where: { planId } });
    await hold(fx, planId, 'end');
    expect(await adminDb.planRevision.count({ where: { planId } })).toBe(before);

    await plansService.approvePlan(planId, fx.ctx);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('on EXPIRY — a revision that died without `end` is recovered by the window', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await hold(fx, planId, 'start');
    await ageTrail(planId, PLAN_REVISION_LEASE_MS + 1000);

    expect(await listings(fx, planId)).toMatchObject({ inWaiting: true, inPlanning: false });
    await plansService.approvePlan(planId, fx.ctx);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

describe('RENEW keeps the hold between writes, and never takes a lapsed one', () => {
  it('a renew inside the window carries the hold past where it would have run out', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await hold(fx, planId, 'start');
    // Eight minutes of silence: still held, two minutes left.
    await ageTrail(planId, PLAN_REVISION_LEASE_MS - 2 * 60 * 1000);

    const renewed = await hold(fx, planId, 'renew');
    expect(renewed.structuredContent).toMatchObject({ planId, action: 'renew', held: true });
    // Another eight minutes: without the renew this is past the window.
    await ageTrail(planId, PLAN_REVISION_LEASE_MS - 2 * 60 * 1000);
    expect(await listings(fx, planId)).toMatchObject({ inWaiting: false, inPlanning: true });

    // The heartbeat is on the trail (the lease reads it) and NOT on the timeline.
    const kinds = (
      await adminDb.planRevision.findMany({ where: { planId }, orderBy: { changedAt: 'asc' } })
    ).map((row) => row.changeKind);
    expect(kinds).toContain('revision_renewed');
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.history.map((ev) => ev.kind)).not.toContain('revision_renewed');
    expect(review.history.map((ev) => ev.kind)).toContain('revision_started');
  });

  it('a renew on a LAPSED hold writes nothing and says so', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await hold(fx, planId, 'start');
    await ageTrail(planId, PLAN_REVISION_LEASE_MS + 1000);
    const before = await adminDb.planRevision.count({ where: { planId } });

    const renewed = await hold(fx, planId, 'renew');
    expect(renewed.structuredContent).toMatchObject({ held: false, expiresAt: null });
    expect(await adminDb.planRevision.count({ where: { planId } })).toBe(before);
    expect(await listings(fx, planId)).toMatchObject({ inWaiting: true, inPlanning: false });
  });
});

describe('the door refuses a decided plan', () => {
  it('START on an approved plan is PLAN_NOT_EDITABLE, as a tool error carrying the code', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx);
    await plansService.approvePlan(planId, fx.ctx);

    await expect(
      plansService.acquireRevisionLease(planId, fx.ctx, {
        source: 'mcp',
        harness: null,
        model: null,
      }),
    ).rejects.toBeInstanceOf(PlanNotEditableError);
    const result = await hold(fx, planId, 'start').catch((e: unknown) => e);
    // `runHoldPlanRevision` throws; the registered handler maps it. Either way the
    // plan's trail gained no lease row.
    expect(result).toBeInstanceOf(PlanNotEditableError);
    expect(
      await adminDb.planRevision.count({ where: { planId, changeKind: 'revision_started' } }),
    ).toBe(0);
  });
});
