import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { PLANNING_STATUS_KEY, PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanStatus } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A CONVERSATION'S PLAN KEEPS ITS TARGETS PARKED THROUGH REVIEW (bug MOTIR-8467) —
// against a REAL Postgres, through the shipped sweep.
//
// A plan opened from the planning overlay parks nothing of its own: the SESSION
// holds the target lock (`planId` null on the row), on the 30-minute session
// lease, which only a turn or a submit refreshes. A hosted walk and the person's
// review make no turns. The sweep spared a `planned` / `stale` plan's lock only
// when the ROW named the plan (MOTIR-5647, MOTIR-6265), so a session-held lock was
// released half an hour after the last submit while its plan still waited for a
// person — the card walked back to `todo` and a run could claim it mid-review.
//
// The lease is a dead-author detector. A session whose plan reached `planned` is
// waiting for a PERSON, exactly as a plan-held lock is, so it is spared the same
// way and reported with the same outcome. A session with only a `generating` plan
// is still the dead-author case, and expires as before.

const T = { timeout: 30_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Just past the session lease — the 19:10 sweep of the reported incident. */
const PAST_LEASE = () => new Date(Date.now() + PLAN_TARGET_LOCK_LEASE_MS + 60_000);

async function seedCard(status: string): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status } });
  return { id: dto.id, key: dto.identifier };
}

/** A planning conversation on the card, holding it the way the overlay does. */
async function openConversation(card: { key: string }): Promise<string> {
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
  await planTargetLockService.acquireForScope(session.id, [card.key], {
    ...fx.ctx,
    projectId: fx.projectId,
  });
  return session.id;
}

async function planIn(sessionId: string, status: PlanStatus) {
  return adminDb.plan.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, sessionId, status },
  });
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const locksOf = (sessionId: string) => adminDb.planTargetLock.count({ where: { sessionId } });

describe('a session-held lock whose session’s plan waits for a person', () => {
  it.each(['planned', 'stale'] as const)(
    'survives the sweep past the session lease while the plan is %s',
    T,
    async (planStatus) => {
      const card = await seedCard('todo');
      const sessionId = await openConversation(card);
      await planIn(sessionId, planStatus);

      const lock = await adminDb.planTargetLock.findUniqueOrThrow({
        where: { workItemId: card.id },
      });
      expect(lock.sessionId).toBe(sessionId);
      expect(lock.planId).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);

      const out = await planTargetLockService.releaseExpired(PAST_LEASE());

      expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'plan_awaiting_review' }]);
      expect(await locksOf(sessionId)).toBe(1);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it(
    'is spared while ANY of the session’s plans waits, beside a later declined one',
    T,
    async () => {
      const card = await seedCard('blocked');
      const sessionId = await openConversation(card);
      await planIn(sessionId, 'planned');
      await planIn(sessionId, 'declined');

      const out = await planTargetLockService.releaseExpired(PAST_LEASE());

      expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'plan_awaiting_review' }]);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});

describe('a session-held lock with no plan waiting for a person still expires', () => {
  it.each(['approved', 'declined', 'generating'] as const)(
    'is released and the prior status restored when the session’s plan is %s',
    T,
    async (planStatus) => {
      const card = await seedCard('todo');
      const sessionId = await openConversation(card);
      await planIn(sessionId, planStatus);

      const out = await planTargetLockService.releaseExpired(PAST_LEASE());

      expect(out.entries).toHaveLength(1);
      expect(out.entries[0]!.workItemId).toBe(card.id);
      expect(out.entries[0]!.outcome).not.toBe('plan_awaiting_review');
      expect(out.released).toBe(1);
      expect(await locksOf(sessionId)).toBe(0);
      expect(await statusOf(card.id)).toBe('todo');
    },
  );

  it('is released when the session has no plan at all', T, async () => {
    const card = await seedCard('blocked');
    const sessionId = await openConversation(card);

    const out = await planTargetLockService.releaseExpired(PAST_LEASE());

    expect(out.released).toBe(1);
    expect(await locksOf(sessionId)).toBe(0);
    expect(await statusOf(card.id)).toBe('blocked');
  });

  it('is left alone before the lease runs out, whatever its plan', T, async () => {
    const card = await seedCard('todo');
    const sessionId = await openConversation(card);
    await planIn(sessionId, 'generating');

    const out = await planTargetLockService.releaseExpired(new Date());

    expect(out.entries).toEqual([]);
    expect(await locksOf(sessionId)).toBe(1);
  });
});
