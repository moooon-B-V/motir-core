import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanStatus } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A FAILED RUN BESIDE A WAITING PLAN KEEPS ITS SESSION (Story MOTIR-7905 · MOTIR-7936) —
// against a REAL Postgres. A failed or canceled REVISION gives its lease back at once; a
// failure records on the plan's open conversation session and leaves the plan decidable;
// no end arm ends a session holding a `planned` / `stale` plan; the sweep settles a
// revision whose failure no relay saw. Races: one settle, one trail row.

const T = { timeout: 60_000 };
const MIN = 60 * 1000;
// Measured: the 20 rounds (a truncate + fixture each) take ~25 s alone; 90 s leaves shard headroom.
const RACE_TEST_TIMEOUT_MS = 90_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const pctx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function seedCard(): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

async function openSession(card: { key: string }): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      scopeKey: card.key,
      targetKeys: [card.key],
      origin: 'conversation',
    },
  });
  await planTargetLockService.acquireForScope(session.id, [card.key], pctx());
  return session.id;
}

async function planIn(
  sessionId: string,
  status: PlanStatus,
  opts: { sourceJobId?: string; createdAt?: Date } = {},
) {
  return adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      sourceJobId: opts.sourceJobId ?? null,
      createdAt: opts.createdAt ?? new Date(),
    },
  });
}

/** An open revision lease on the plan, started `agoMs` ago, held by `jobId`. */
async function startRevision(planId: string, jobId: string, agoMs = 0) {
  await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: jobId } });
  await adminDb.planRevision.create({
    data: {
      planId,
      changeKind: 'revision_started',
      changedById: fx.ctx.userId,
      changedAt: new Date(Date.now() - agoMs),
      diff: { revision: true, jobId },
    },
  });
}

const trail = (planId: string, kind: string) =>
  adminDb.planRevision.count({ where: { planId, changeKind: kind } });
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const locksOf = (sessionId: string) => adminDb.planTargetLock.count({ where: { sessionId } });

const readJob = async () => ({
  error: { code: 'rate_limited', message: 'slow' },
  walkStop: null,
});

describe('a failed revision', () => {
  it('releases the lease, records on the session, leaves the plan decidable', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, 'planned');
    await startRevision(plan.id, 'rev-1');

    const out = await planSessionEndService.settleFailedJob(
      'rev-1',
      pctx(),
      { status: 'failed' },
      { readJob },
    );

    expect(out).toEqual({ settled: 'recorded', sessionId });
    expect(await trail(plan.id, 'revision_ended')).toBe(1);
    const s = await sessionRow(sessionId);
    expect(s.endedAt).toBeNull();
    expect(s.failedAt).not.toBeNull();
    expect(s.failedJobId).toBe('rev-1');
    expect((await planRow(plan.id)).status).toBe('planned');
    expect(await locksOf(sessionId)).toBeGreaterThan(0);
  });

  it('a canceled revision only gives the lease back', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, 'stale');
    await startRevision(plan.id, 'rev-2');

    const out = await planSessionEndService.settleFailedJob(
      'rev-2',
      pctx(),
      { status: 'canceled' },
      { readJob },
    );

    expect(out).toEqual({ settled: 'released', sessionId });
    expect(await trail(plan.id, 'revision_ended')).toBe(1);
    expect((await sessionRow(sessionId)).failedAt).toBeNull();
  });

  it('a job that is no longer the plan holder settles nothing', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, 'planned');
    await startRevision(plan.id, 'rev-new');

    const out = await planSessionEndService.settleFailedJob(
      'rev-old',
      pctx(),
      { status: 'failed' },
      { readJob },
    );

    expect(out).toBeNull();
    expect(await trail(plan.id, 'revision_ended')).toBe(0);
  });

  it(
    'two settles of one job leave ONE trail row and ONE record (x20)',
    { timeout: RACE_TEST_TIMEOUT_MS },
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const card = await seedCard();
        const sessionId = await openSession(card);
        const plan = await planIn(sessionId, 'planned');
        await startRevision(plan.id, `rev-race-${i}`);

        await Promise.all([
          planSessionEndService.settleFailedJob(
            `rev-race-${i}`,
            pctx(),
            { status: 'failed' },
            { readJob },
          ),
          planSessionEndService.settleFailedJob(
            `rev-race-${i}`,
            pctx(),
            { status: 'failed' },
            { readJob },
          ),
        ]);

        expect(await trail(plan.id, 'revision_ended')).toBe(1);
        const s = await sessionRow(sessionId);
        expect(s.failedJobId).toBe(`rev-race-${i}`);
        expect(s.endedAt).toBeNull();
      }
    },
  );
});

describe('no end arm ends a session holding a waiting plan', () => {
  it('a failure beside a planned plan declines only the generating one', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const waiting = await planIn(sessionId, 'planned', {
      createdAt: new Date(Date.now() - 60 * MIN),
    });
    const attempt = await planIn(sessionId, 'generating', { sourceJobId: 'gen-2' });

    const out = await planSessionEndService.endSession(sessionId, 'failed', {
      workspaceId: fx.workspaceId,
    });

    expect(out.ended).toBe(false);
    const s = await sessionRow(sessionId);
    expect(s.endedAt).toBeNull();
    expect(s.failedAt).toBeNull();
    expect((await planRow(waiting.id)).status).toBe('planned');
    const declined = await planRow(attempt.id);
    expect(declined.status).toBe('declined');
    expect(declined.decisionReason).toBe('abandoned');
  });

  it('a canceled generating job beside a waiting plan keeps the session', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const waiting = await planIn(sessionId, 'planned', {
      createdAt: new Date(Date.now() - 60 * MIN),
    });
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastJobId: 'gen-3' },
    });
    await planIn(sessionId, 'generating', { sourceJobId: 'gen-3' });

    const out = await planSessionEndService.settleFailedJob('gen-3', pctx(), {
      status: 'canceled',
    });

    expect(out?.settled).toBe('ended');
    expect((await sessionRow(sessionId)).endedAt).toBeNull();
    expect((await planRow(waiting.id)).status).toBe('planned');
  });

  it('with no waiting plan the failed end is unchanged', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    await planIn(sessionId, 'generating');

    const out = await planSessionEndService.endSession(sessionId, 'failed', {
      workspaceId: fx.workspaceId,
    });

    expect(out.ended).toBe(true);
    expect(await locksOf(sessionId)).toBe(0);
  });
});

describe('the sweep backstop', () => {
  const dead = (status: 'failed' | 'canceled' | 'succeeded') => ({
    resolveJobState: async () => ({
      jobId: 'x',
      reachable: true,
      status,
      failure: status === 'failed' ? { code: 'boom', message: 'boom' } : null,
    }),
  });

  it(
    'reads the stop point through the injected walk-stop reader on the revision arm',
    T,
    async () => {
      const card = await seedCard();
      const sessionId = await openSession(card);
      const plan = await planIn(sessionId, 'planned');
      await startRevision(plan.id, 'rev-sweep-stop', 30 * MIN);

      const summary = await abandonedPlanService.reconcileAbandoned({
        deps: { ...dead('failed'), getJobWalkStop: async () => null } as never,
      });

      expect(summary.outcomes).toContainEqual(
        expect.objectContaining({ planId: plan.id, outcome: 'revision_failed' }),
      );
    },
  );

  it('settles a stale revision whose job failed', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, 'planned');
    await startRevision(plan.id, 'rev-sweep', 30 * MIN);

    const summary = await abandonedPlanService.reconcileAbandoned({
      deps: dead('failed') as never,
    });

    expect(summary.outcomes).toContainEqual(
      expect.objectContaining({ planId: plan.id, outcome: 'revision_failed' }),
    );
    expect(await trail(plan.id, 'revision_ended')).toBe(1);
    expect((await sessionRow(sessionId)).failedJobId).toBe('rev-sweep');
  });

  it('releases the lease of a revision that ended without failing', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, 'planned');
    await startRevision(plan.id, 'rev-done', 30 * MIN);

    const summary = await abandonedPlanService.reconcileAbandoned({
      deps: dead('succeeded') as never,
    });

    expect(summary.outcomes).toContainEqual(
      expect.objectContaining({ planId: plan.id, outcome: 'revision_released' }),
    );
    expect((await sessionRow(sessionId)).failedAt).toBeNull();
  });

  it('leaves a revision whose job still runs, and a young lease', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, 'planned');
    await startRevision(plan.id, 'rev-live', 30 * MIN);
    const running = {
      resolveJobState: async () => ({ jobId: 'x', reachable: true, status: 'running' }),
    };

    const summary = await abandonedPlanService.reconcileAbandoned({ deps: running as never });
    expect(summary.outcomes).toContainEqual(
      expect.objectContaining({ planId: plan.id, outcome: 'left_as_is' }),
    );
    expect(await trail(plan.id, 'revision_ended')).toBe(0);

    await adminDb.planRevision.deleteMany({ where: { planId: plan.id } });
    await startRevision(plan.id, 'rev-young', 1 * MIN);
    const young = await abandonedPlanService.reconcileAbandoned({ deps: dead('failed') as never });
    expect(young.outcomes.some((o) => o.planId === plan.id)).toBe(false);
  });
});
