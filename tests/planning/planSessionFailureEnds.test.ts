import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isTerminalFailureFrame } from '@/lib/ai/jobStream';
import { PLANNING_STATUS_KEY, PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import type { PlanSessionOrigin } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A FAILED ATTEMPT ENDS ITS SESSION (story MOTIR-7630 · MOTIR-7638) — against a
// REAL Postgres. `docs/decisions/agent-authored-plans.md` AMENDMENT 23 §2: the
// stream relays end the session on a terminal frame, the abandoned-plan sweep ends
// it as a backstop, and the lock sweep closes an idle session. This is the defect
// that started the story: three failed attempts each held their card for up to an
// hour until a sweep let it go.

const DB_TEST_TIMEOUT_MS = 30_000;
const HOUR = 60 * 60 * 1000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function openSession(
  card: { key: string },
  opts: { lastJobId?: string; idleMs?: number; origin?: PlanSessionOrigin } = {},
): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      scopeKey: card.key,
      targetKeys: [card.key],
      lastJobId: opts.lastJobId ?? null,
      origin: opts.origin ?? 'conversation',
    },
  });
  await planTargetLockService.acquireForScope(session.id, [card.key], {
    ...fx.ctx,
    projectId: fx.projectId,
  });
  if (opts.idleMs) {
    await adminDb.planChangeSession.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date(Date.now() - opts.idleMs) },
    });
  }
  return session.id;
}

async function endOf(id: string) {
  const s = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
  return { endedAt: s.endedAt, endReason: s.endReason };
}

const pctx = () => ({ ...fx.ctx, projectId: fx.projectId });

describe('the relay — a terminal frame ends the attempt', () => {
  it('reads `failed` and `canceled` status frames as terminal, and nothing else', () => {
    expect(isTerminalFailureFrame({ event: 'status', data: { status: 'failed' } })).toBe(true);
    expect(isTerminalFailureFrame({ event: 'status', data: { status: 'canceled' } })).toBe(true);
    expect(isTerminalFailureFrame({ event: 'status', data: { status: 'running' } })).toBe(false);
    expect(isTerminalFailureFrame({ event: 'status', data: { status: 'succeeded' } })).toBe(false);
    expect(isTerminalFailureFrame({ event: 'done', data: {} })).toBe(false);
  });

  it(
    'ends the session whose CURRENT job failed and gives its card back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSession(card, { lastJobId: 'job-1' });
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);

      const out = await planSessionEndService.endSessionForFailedJob('job-1', pctx());

      expect(out?.ended).toBe(true);
      expect((await endOf(sessionId)).endReason).toBe('failed');
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );

  it(
    'an OLDER job of a session that submitted again ends nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSession(card, { lastJobId: 'job-2' });

      expect(await planSessionEndService.endSessionForFailedJob('job-1', pctx())).toBeNull();
      expect((await endOf(sessionId)).endedAt).toBeNull();
    },
  );
});

describe('the abandoned-plan sweep — the backstop', () => {
  async function abandonedPlanIn(sessionId: string) {
    return adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId,
        status: 'generating',
        createdAt: new Date(Date.now() - 72 * HOUR),
      },
    });
  }

  it('run alone, ends the session `failed`', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    await abandonedPlanIn(sessionId);

    await abandonedPlanService.reconcileAbandoned();

    expect((await endOf(sessionId)).endReason).toBe('failed');
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it(
    'after the relay already ended the attempt, writes no new end',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSession(card, { lastJobId: 'job-1' });
      await abandonedPlanIn(sessionId);
      await planSessionEndService.endSessionForFailedJob('job-1', pctx());
      const first = await endOf(sessionId);

      await abandonedPlanService.reconcileAbandoned();

      expect(await endOf(sessionId)).toEqual(first);
    },
  );
});

describe('the idle close', () => {
  it(
    'ends an idle session past its lease and gives its card back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSession(card, { idleMs: PLAN_TARGET_LOCK_LEASE_MS + 60_000 });

      const out = await planSessionEndService.closeIdleSessions();

      expect(out.sessionIds).toEqual([sessionId]);
      expect((await endOf(sessionId)).endReason).toBe('idle');
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );

  it(
    'leaves a recent session, a guide session and a session whose plan waits for a person',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const recent = await openSession(await seedCard(), { idleMs: 60_000 });
      const guide = await openSession(await seedCard(), {
        origin: 'guide',
        idleMs: 2 * HOUR,
      });
      const waiting = await openSession(await seedCard(), { idleMs: 2 * HOUR });
      await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId: waiting,
          status: 'planned',
        },
      });

      const out = await planSessionEndService.closeIdleSessions();

      expect(out.closed).toBe(0);
      for (const id of [recent, guide, waiting]) expect((await endOf(id)).endedAt).toBeNull();
    },
  );

  it(
    'a turn that lands after discovery wins — the end re-checks under the lock',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await openSession(await seedCard());
      const olderThan = new Date(Date.now() - PLAN_TARGET_LOCK_LEASE_MS);

      const out = await planSessionEndService.endSession(sessionId, 'idle', {
        workspaceId: fx.workspaceId,
        onlyIfIdleBefore: olderThan,
      });

      expect(out.ended).toBe(false);
      expect((await endOf(sessionId)).endedAt).toBeNull();
    },
  );
});
