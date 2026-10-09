import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import {
  PlanSessionNotCopyableError,
  PlanSessionNotFoundError,
  PlanSessionPlanDecidedError,
  PlanTargetLockedError,
} from '@/lib/planChange/errors';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { planRepository } from '@/lib/repositories/planRepository';
import { usersService } from '@/lib/services/usersService';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// THE CARRY (Story MOTIR-7928 · MOTIR-7930) — against a REAL Postgres. An ended
// conversation that still holds an UNDECIDED plan is carried, on its owner's
// first turn, into a new session that owns that plan and holds the scope's cards.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;
let cardKey: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  const card = await createTestWorkItem(fx, { kind: 'story', title: 'Exports for large projects' });
  cardKey = card.identifier;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

/** An ENDED conversation of the owner's, scoped at the card, with two turns. */
async function endedSession(reason: 'failed' | 'idle' | 'restarted' | 'approved' | 'declined') {
  const scope = buildScope([cardKey]);
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: scope.scopeKey,
      targetKeys: scope.targetKeys,
      turnCount: 2,
      endedAt: new Date(),
      endReason: reason,
    },
  });
  await adminDb.planChangeTurn.createMany({
    data: [
      {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        seq: 0,
        role: 'user',
        body: 'Split the export work',
        authorId: fx.ownerId,
      },
      {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        seq: 1,
        role: 'assistant',
        body: 'CSV goes first.',
      },
    ],
  });
  return session.id;
}

async function planIn(sessionId: string, status: PlanStatus, createdAt = new Date()) {
  return adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      createdById: fx.ownerId,
      createdAt,
    },
  });
}

describe('the copyable read names a session whose plan still waits', () => {
  it('a `restarted` session holding a planned plan', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const id = await endedSession('restarted');
    const plan = await planIn(id, 'planned');
    const out = await planChangeSessionsService.findResumableWithEarlier(me(), cardKey);
    expect(out.copyable).toMatchObject({ id, endReason: 'restarted', waitingPlanId: plan.id });
  });

  it.each(['restarted', 'approved', 'declined'] as const)(
    'not a session ended %s with no undecided plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (reason) => {
      const id = await endedSession(reason);
      await planIn(id, reason === 'declined' ? 'declined' : 'approved');
      expect(
        (await planChangeSessionsService.findResumableWithEarlier(me(), cardKey)).copyable,
      ).toBeNull();
    },
  );

  it.each(['failed', 'idle'] as const)(
    'a session ended %s with no plan, carrying the conversation only',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (reason) => {
      const id = await endedSession(reason);
      const out = await planChangeSessionsService.findResumableWithEarlier(me(), cardKey);
      expect(out.copyable).toMatchObject({ id, endReason: reason, waitingPlanId: null });
    },
  );
});

describe('startCopied carries the waiting plan', () => {
  it(
    'moves the plan, copies the turns, holds the cards, records the move and appends the turn',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      const plan = await planIn(sourceId, 'planned');
      const before = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } });

      const out = await planChangeSessionsService.startCopied(me(), sourceId, {
        body: 'Keep the PDF report in this sprint',
      });

      expect(out.id).not.toBe(sourceId);
      expect(out.takenBack).toBeUndefined();
      expect(out.turns.map((t) => [t.role, t.body])).toEqual([
        ['user', 'Split the export work'],
        ['assistant', 'CSV goes first.'],
        ['user', 'Keep the PDF report in this sprint'],
      ]);
      const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: out.id } });
      expect(row).toMatchObject({ copiedFromSessionId: sourceId, endedAt: null, turnCount: 3 });

      // The plan MOVED: every "the session's plan" read now finds it there.
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).sessionId).toBe(
        out.id,
      );
      const latest = await adminDb.$transaction((tx) =>
        planRepository.findLatestBySession(out.id, tx),
      );
      expect(latest?.id).toBe(plan.id);
      expect((await planChangeSessionsService.getById(me(), sourceId)).pendingPlanId).toBeNull();
      expect((await planChangeSessionsService.getById(me(), out.id)).pendingPlanId).toBe(plan.id);

      // The source stayed ended, unchanged.
      const after = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } });
      expect(after).toEqual(before);
      expect(await adminDb.planChangeTurn.count({ where: { sessionId: sourceId } })).toBe(2);

      // The new session holds the scope's card.
      const locks = await adminDb.planTargetLock.findMany({ where: { sessionId: out.id } });
      expect(locks).toHaveLength(1);
      expect(locks[0]!.planId).toBeNull();

      // Exactly one trail row for the move.
      const trail = await adminDb.planRevision.findMany({
        where: { planId: plan.id, changeKind: 'session_carried' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.diff).toEqual({ fromSessionId: sourceId, toSessionId: out.id });
      expect(trail[0]!.changedById).toBe(fx.ownerId);
    },
  );

  it(
    'moves the EARLIER undecided plan, not the declined attempt on top of it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('failed');
      const waiting = await planIn(sourceId, 'planned', new Date(Date.now() - 60_000));
      const attempt = await planIn(sourceId, 'declined');

      const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'Go on' });

      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: waiting.id } })).sessionId).toBe(
        out.id,
      );
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: attempt.id } })).sessionId).toBe(
        sourceId,
      );
    },
  );

  it(
    'without a body, carries and holds but appends nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      const plan = await planIn(sourceId, 'stale');

      const out = await planChangeSessionsService.startCopied(me(), sourceId);

      expect(out.turns).toHaveLength(2);
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).sessionId).toBe(
        out.id,
      );
      expect(await adminDb.planTargetLock.count({ where: { sessionId: out.id } })).toBe(1);
    },
  );

  it(
    'refuses a plan decided before the send, and writes nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      const plan = await planIn(sourceId, 'approved');

      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'More', planId: plan.id }),
      ).rejects.toBeInstanceOf(PlanSessionPlanDecidedError);
      expect(await adminDb.planChangeSession.count()).toBe(1);
      expect(await adminDb.planRevision.count()).toBe(0);
      expect(await adminDb.planTargetLock.count()).toBe(0);
    },
  );

  it(
    'lands the turn on the caller’s OPEN session for the scope, and moves nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      const plan = await planIn(sourceId, 'planned');
      const open = await planChangeSessionsService.startWithFirstTurn(
        me(),
        buildScope([cardKey]),
        'Something new',
      );

      const out = await planChangeSessionsService.startCopied(me(), sourceId, {
        body: 'Back to it',
      });

      expect(out.id).toBe(open.id);
      expect(out.takenBack).toBe(true);
      expect(out.turns.map((t) => t.body).at(-1)).toBe('Back to it');
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).sessionId).toBe(
        sourceId,
      );
      expect(await adminDb.planChangeSession.count()).toBe(2);
      expect(await adminDb.planRevision.count()).toBe(0);
    },
  );

  it(
    'two racing first turns make ONE session and move the plan once',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      const plan = await planIn(sourceId, 'planned');

      const [a, b] = await Promise.all([
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'One' }),
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'Two' }),
      ]);

      expect(a.id).toBe(b.id);
      expect(
        await adminDb.planChangeSession.count({ where: { copiedFromSessionId: sourceId } }),
      ).toBe(1);
      expect(
        await adminDb.planRevision.count({
          where: { planId: plan.id, changeKind: 'session_carried' },
        }),
      ).toBe(1);
      expect(await adminDb.planChangeTurn.count({ where: { sessionId: a.id } })).toBe(4);
    },
  );

  it(
    'another member’s hold refuses the carry and rolls it all back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      const plan = await planIn(sourceId, 'planned');
      const mate = await member('mate@example.com');
      await planChangeSessionsService.startWithFirstTurn(
        { ...me(), userId: mate },
        buildScope([cardKey]),
        'Mine now',
      );

      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'Back to it' }),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);
      expect(
        await adminDb.planChangeSession.count({ where: { copiedFromSessionId: sourceId } }),
      ).toBe(0);
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).sessionId).toBe(
        sourceId,
      );
      expect(await adminDb.planRevision.count()).toBe(0);
    },
  );

  it('another member gets NOT FOUND', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const sourceId = await endedSession('restarted');
    await planIn(sourceId, 'planned');
    const mate = await member('mate@example.com');
    await expect(
      planChangeSessionsService.startCopied({ ...me(), userId: mate }, sourceId, { body: 'x' }),
    ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
  });

  it(
    'still refuses a `restarted` session with no waiting plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('restarted');
      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'x' }),
      ).rejects.toBeInstanceOf(PlanSessionNotCopyableError);
    },
  );
});

async function member(email: string): Promise<string> {
  const u = await usersService.createUser({
    email,
    password: 'correct-horse-battery-staple-9',
    name: 'Mate',
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  return u.id;
}
