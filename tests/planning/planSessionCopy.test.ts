import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanChangeTurnRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { PlanSessionNotCopyableError, PlanSessionNotFoundError } from '@/lib/planChange/errors';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { usersService } from '@/lib/services/usersService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// THE COPY (story MOTIR-7630 · MOTIR-7641) — against a REAL Postgres.
// `docs/decisions/agent-authored-plans.md` AMENDMENT 23 §6: a session Motir ended
// (`failed` or `idle`) is offered to its starter as copyable, and a copy is a NEW
// session of the same scope holding the source's user and assistant turns in
// order — no system turn, no pending question, no job id, no plan, no lock.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
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

/** An ended project-wide conversation of the owner's, with a mixed thread. */
async function endedSession(reason: 'failed' | 'idle' | 'restarted' | 'approved' | 'declined') {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: PROJECT_SCOPE_KEY,
      targetKeys: [],
      turnCount: 4,
    },
  });
  const turns: Array<{
    role: PlanChangeTurnRole;
    body: string;
    question?: string;
    jobId?: string;
  }> = [
    { role: 'user', body: 'Split the billing epic' },
    { role: 'assistant', body: 'Which part first?', question: 'Which part?', jobId: 'job-1' },
    { role: 'system', body: 'The attempt failed.' },
    { role: 'user', body: 'Invoices first' },
  ];
  for (const [seq, t] of turns.entries()) {
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        seq,
        role: t.role,
        body: t.body,
        question: t.question ?? null,
        jobId: t.jobId ?? null,
        authorId: t.role === 'user' ? fx.ownerId : null,
      },
    });
  }
  await adminDb.planChangeSession.update({
    where: { id: session.id },
    data: { endedAt: new Date(), endReason: reason },
  });
  return session.id;
}

describe('the copyable read', () => {
  it.each(['failed', 'idle'] as const)(
    'names a session that ended %s',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (reason) => {
      const id = await endedSession(reason);
      const out = await planChangeSessionsService.findResumableWithEarlier(me());
      expect(out.session).toBeNull();
      expect(out.copyable).toMatchObject({ id, endReason: reason, turnCount: 4 });
    },
  );

  it.each(['restarted', 'approved', 'declined'] as const)(
    'never names a session that ended %s',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (reason) => {
      await endedSession(reason);
      expect((await planChangeSessionsService.findResumableWithEarlier(me())).copyable).toBeNull();
    },
  );
});

describe('startCopied', () => {
  it(
    'creates ONE new session with the user and assistant turns in order, and leaves the source as it was',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('failed');
      const before = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } });

      const copy = await planChangeSessionsService.startCopied(me(), sourceId);

      expect(copy.id).not.toBe(sourceId);
      const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: copy.id } });
      expect(row).toMatchObject({ copiedFromSessionId: sourceId, endedAt: null, turnCount: 3 });
      const turns = await adminDb.planChangeTurn.findMany({
        where: { sessionId: copy.id },
        orderBy: { seq: 'asc' },
      });
      expect(turns.map((t) => [t.seq, t.role, t.body])).toEqual([
        [0, 'user', 'Split the billing epic'],
        [1, 'assistant', 'Which part first?'],
        [2, 'user', 'Invoices first'],
      ]);
      // Not a pending question, not the old job's idempotency key.
      expect(turns.every((t) => t.question === null && t.jobId === null)).toBe(true);
      expect(turns[0]!.authorId).toBe(fx.ownerId);
      // No plan and no lock rode along.
      expect(await adminDb.planTargetLock.count({ where: { sessionId: copy.id } })).toBe(0);
      expect(
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } }),
      ).toEqual(before);
    },
  );

  it('two racing copies create ONE session', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const sourceId = await endedSession('idle');

    const [a, b] = await Promise.all([
      planChangeSessionsService.startCopied(me(), sourceId),
      planChangeSessionsService.startCopied(me(), sourceId),
    ]);

    expect(a.id).toBe(b.id);
    expect(
      await adminDb.planChangeSession.count({ where: { copiedFromSessionId: sourceId } }),
    ).toBe(1);
  });

  it(
    'the next resume read returns the copy, and a first turn lands on it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('failed');
      const copy = await planChangeSessionsService.startCopied(me(), sourceId);

      const resumed = await planChangeSessionsService.findResumableWithEarlier(me());
      expect(resumed.session?.id).toBe(copy.id);
      const next = await planChangeSessionsService.startWithFirstTurn(
        me(),
        PROJECT_SCOPE,
        'Now the refunds',
      );
      expect(next.id).toBe(copy.id);
      expect(next.turns.map((t) => t.body).at(-1)).toBe('Now the refunds');
    },
  );

  it.each(['restarted', 'approved', 'declined'] as const)(
    'refuses a source that ended %s',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (reason) => {
      const sourceId = await endedSession(reason);
      await expect(planChangeSessionsService.startCopied(me(), sourceId)).rejects.toBeInstanceOf(
        PlanSessionNotCopyableError,
      );
      expect(await adminDb.planChangeSession.count()).toBe(1);
    },
  );

  it('refuses an OPEN source', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const open = await planChangeSessionsService.startWithFirstTurn(me(), PROJECT_SCOPE, 'hi');
    // The open session is the caller's own, so the copy lands on it instead of
    // forking — the same answer two racing copies get.
    const out = await planChangeSessionsService.startCopied(me(), open.id);
    expect(out.id).toBe(open.id);
    expect(await adminDb.planChangeSession.count()).toBe(1);
  });

  it(
    'another member’s session is NOT FOUND — an id confirms nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sourceId = await endedSession('failed');
      const u = await usersService.createUser({
        email: 'mate@example.com',
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

      await expect(
        planChangeSessionsService.startCopied({ ...me(), userId: u.id }, sourceId),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
    },
  );

  it(
    'copies a session the end operation ended, end to end',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await planChangeSessionsService.startWithFirstTurn(
        me(),
        PROJECT_SCOPE,
        'Plan the release',
      );
      await planSessionEndService.endSession(s.id, 'failed', { workspaceId: fx.workspaceId });

      const copy = await planChangeSessionsService.startCopied(me(), s.id);
      expect(copy.turns.map((t) => t.body)).toEqual(['Plan the release']);
    },
  );
});
