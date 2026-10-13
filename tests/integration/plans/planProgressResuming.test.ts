import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planProgressService } from '@/lib/services/planProgressService';
import { planReviewService } from '@/lib/services/planReviewService';
import { readPlanProgress } from '@/lib/plans/planProgress';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-8301 · MOTIR-8309 — a plan Motir resumed BY ITSELF reads `resuming` through BOTH
// progress doors, against real Postgres: the page read (`snapshotsForPlans`, Workbench › Planning)
// and the review read (`snapshotForReview`, through `getPlanReview`). The lost machine's own step
// row is never cleared, so it must not read as live; the new job's first signal ends the state.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const MIN = 60_000;

/**
 * A `generating` plan in an open session that Motir resumed automatically at `resumedAt`: the
 * bind's stamps (`lastActivityAt = lastAutoResumedAt = resumedAt`) and the lost machine's step,
 * started three minutes before the resume.
 */
async function resumedPlan(fx: WorkItemFixture, resumedAt: Date, title = 'Resumed') {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'Saved', kind: 'task', descriptionMd: 'Body' } }],
    fx.ctx,
  );
  await plansService.recordPlanStep(
    plan.id,
    { sessionKey: 'dead', kind: 'settle', targetRef: null },
    fx.ctx,
  );
  await adminDb.planStep.updateMany({
    where: { planId: plan.id, sessionKey: 'dead' },
    data: { startedAt: new Date(resumedAt.getTime() - 3 * MIN) },
  });
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: '',
      targetKeys: [],
      autoResumeCount: 1,
      lastAutoResumedAt: resumedAt,
    },
  });
  await adminDb.plan.update({
    where: { id: plan.id },
    data: { sessionId: session.id, lastActivityAt: resumedAt },
  });
  return plan.id;
}

const planInputs = async (ids: string[]) =>
  (await adminDb.plan.findMany({ where: { id: { in: ids } } })).map((p) => ({
    id: p.id,
    projectId: p.projectId,
    status: p.status,
    createdAt: p.createdAt,
    lastActivityAt: p.lastActivityAt,
    authorSource: p.authorSource,
    sessionId: p.sessionId,
  }));

async function bothDoors(planId: string, fx: WorkItemFixture) {
  const page = (
    await planProgressService.snapshotsForPlans(await planInputs([planId]), fx.ctx)
  ).get(planId)!;
  const review = (await planReviewService.getPlanReview(planId, fx.ctx)).progress!;
  return { page, review };
}

/** Every statement the pg driver sends, minus the transaction's own frames. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await fn();
    return spy.mock.calls.filter(([q]) => {
      const text = typeof q === 'string' ? q : ((q as { text?: string })?.text ?? '');
      return !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(text);
    }).length;
  } finally {
    spy.mockRestore();
  }
}

describe('an automatically resumed plan reads resuming through both doors', () => {
  it('resuming with the dead step dropped, then working on the new job’s first step', async () => {
    const fx = await makeWorkItemFixture();
    const resumedAt = new Date(Date.now() - 30_000);
    const planId = await resumedPlan(fx, resumedAt);

    for (const snapshot of Object.values(await bothDoors(planId, fx))) {
      expect(snapshot.autoResume).toEqual({ at: resumedAt.toISOString(), count: 1 });
      expect(snapshot.steps).toEqual([]);
      const reading = readPlanProgress(snapshot, Date.parse(snapshot.observedAt));
      expect(reading.state).toBe('resuming');
      expect(reading.liveSteps).toEqual([]);
    }

    // The new job's first signal — a step upsert, which stamps the plan's activity.
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'new', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    for (const snapshot of Object.values(await bothDoors(planId, fx))) {
      const reading = readPlanProgress(snapshot, Date.parse(snapshot.observedAt));
      expect(reading.state).toBe('working');
      expect(reading.liveSteps.map((s) => s.sessionKey)).toEqual(['new']);
    }
  });

  it('a plan whose session was never resumed automatically carries no resume', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Plain' }, fx.ctx);
    const { page, review } = await bothDoors(plan.id, fx);
    expect(page.autoResume).toBeNull();
    expect(review.autoResume).toBeNull();
  });

  it('snapshotsForPlans costs the same number of queries for 1 plan and for 10', async () => {
    const fx = await makeWorkItemFixture();
    const resumedAt = new Date(Date.now() - 30_000);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await resumedPlan(fx, resumedAt, `R${i}`));
    const all = await planInputs(ids);

    const one = await countQueries(() =>
      planProgressService.snapshotsForPlans(all.slice(0, 1), fx.ctx),
    );
    const ten = await countQueries(() => planProgressService.snapshotsForPlans(all, fx.ctx));
    expect(one).toBeGreaterThan(0);
    expect(ten).toBe(one);
  });
});
