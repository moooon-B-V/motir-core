import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { PlanChangeSessionNotFoundError, PlanSessionNotFoundError } from '@/lib/planChange/errors';
import { PLANNING_STATUS_KEY, PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE SESSION LIFECYCLE, ASSEMBLED (Story MOTIR-7630 · MOTIR-7644) — the story's
// integration gate, against a REAL Postgres, with motir-ai stubbed at its client.
// `docs/decisions/agent-authored-plans.md` AMENDMENT 23. Each card's own suite
// pins its seam (`tests/planning/planSessionEnd*.test.ts`, `planSessionFailureEnds`,
// `planSessionCopy`, `planHoldGuard`, `tests/ai/planChangeSessionsById`,
// `tests/integration/plans/planSessionsList`); this file holds what only the
// seams TOGETHER can show: the relay and the backstop racing on one attempt, an
// end that holds across every resume door, the sweeps leaving a reviewer's plan
// alone, the tenant boundary, and the whole failed-then-carried-on journey.

const submitJobMock = vi.fn(async () => ({ jobId: 'job-lifecycle-1' }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');

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

function me(f: WorkItemFixture = fx): ProjectContext {
  return {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

async function seedCard(f: WorkItemFixture = fx): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'task', title: 'The card' },
    f.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function endOf(id: string) {
  const s = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
  return { endedAt: s.endedAt, endReason: s.endReason, endedById: s.endedById };
}

/** A person's open session on the card, through the real first-turn door. */
async function openOn(card: { key: string }, f: WorkItemFixture = fx) {
  return planChangeSessionsService.startWithFirstTurn(me(f), buildScope([card.key]), 'Split it');
}

describe('the relay and the backstop race on ONE attempt (AMENDMENT 23 §2)', () => {
  it(
    'write exactly one end, and give the card back once',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const session = await openOn(card);
      await adminDb.planChangeSession.update({
        where: { id: session.id },
        data: { lastJobId: 'job-race' },
      });
      const plan = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId: session.id,
          status: 'generating',
          createdAt: new Date(Date.now() - 72 * HOUR),
        },
      });
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);

      const outcomes = await Promise.all([
        planSessionEndService.endSessionForFailedJob('job-race', {
          ...fx.ctx,
          projectId: fx.projectId,
        }),
        planSessionEndService.endSessionForAbandonedPlan({
          id: plan.id,
          workspaceId: fx.workspaceId,
          sessionId: session.id,
        }),
      ]);

      // One of the two wrote the end; the other found it written.
      expect(outcomes.filter((o) => o?.ended === true)).toHaveLength(1);
      const first = await endOf(session.id);
      expect(first.endReason).toBe('failed');
      expect(first.endedById).toBeNull();
      expect(await statusOf(card.id)).toBe('in_progress');
      expect(await adminDb.planTargetLock.count({ where: { workItemId: card.id } })).toBe(0);

      // A third end — any reason — is a no-op that keeps the first.
      const again = await planSessionEndService.endSession(session.id, 'idle', {
        workspaceId: fx.workspaceId,
      });
      expect(again.ended).toBe(false);
      expect(await endOf(session.id)).toEqual(first);
    },
  );
});

describe('every Motir end gives the cards back to where they were (AMENDMENT 23 §1)', () => {
  it.each(['failed', 'idle', 'restarted'] as const)(
    '`%s` releases a card held from In Progress back to In Progress',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (reason) => {
      const card = await seedCard();
      const session = await openOn(card);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);

      await planSessionEndService.endSession(session.id, reason, { workspaceId: fx.workspaceId });

      expect((await endOf(session.id)).endReason).toBe(reason);
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );
});

describe('an ENDED session is never resumed, by any door (AMENDMENT 23 §3)', () => {
  it(
    'the project resume, the item resume and a first turn all start fresh',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const onCard = await openOn(card);
      const onProject = await planChangeSessionsService.startWithFirstTurn(
        me(),
        PROJECT_SCOPE,
        'Plan the release',
      );
      for (const s of [onCard, onProject]) {
        await planSessionEndService.endSession(s.id, 'failed', { workspaceId: fx.workspaceId });
      }

      expect(await planChangeSessionsService.findResumable(me(), PROJECT_SCOPE_KEY)).toBeNull();
      expect(
        await planChangeSessionsService.findResumable(me(), buildScope([card.key]).scopeKey),
      ).toBeNull();
      const item = await contextualPlanningService.getSessionForWorkItem(
        { anchorId: card.id },
        me(),
      );
      expect(item.session).toBeNull();
      // Nobody holds the card any more, so nothing is refused either.
      expect(item.heldBy).toBeNull();

      const fresh = await openOn(card);
      expect(fresh.id).not.toBe(onCard.id);
      expect(fresh.copiedFromSessionId).toBeNull();
    },
  );

  it(
    'an OPEN session of any age IS resumed — there is no window',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await planChangeSessionsService.startWithFirstTurn(
        me(),
        PROJECT_SCOPE,
        'Plan the release',
      );
      await adminDb.planChangeSession.update({
        where: { id: s.id },
        data: { lastActivityAt: new Date(Date.now() - 30 * 24 * HOUR) },
      });

      expect((await planChangeSessionsService.findResumable(me()))?.id).toBe(s.id);
    },
  );
});

describe('the sweeps leave a plan that waits for its reviewer alone', () => {
  it(
    'a `planned` plan keeps its 24-hour lease through the idle close, the backstop and the lease sweep',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const session = await openOn(card);
      await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId: session.id,
          status: 'planned',
        },
      });
      // Idle well past the session lease, as a reviewer who has not looked yet.
      await adminDb.planChangeSession.update({
        where: { id: session.id },
        data: { lastActivityAt: new Date(Date.now() - PLAN_TARGET_LOCK_LEASE_MS - HOUR) },
      });
      const lockBefore = await adminDb.planTargetLock.findUniqueOrThrow({
        where: { workItemId: card.id },
      });

      await planSessionEndService.closeIdleSessions();
      await abandonedPlanService.reconcileAbandoned();

      expect((await endOf(session.id)).endedAt).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      expect(
        await adminDb.planTargetLock.findUniqueOrThrow({ where: { workItemId: card.id } }),
      ).toEqual(lockBefore);
    },
  );
});

describe('no end, copy or hold crosses a workspace', () => {
  it(
    'another tenant cannot end, copy or see the hold of this one’s session',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
      const card = await seedCard();
      const session = await openOn(card);

      // END: the session is not found under the other workspace, and stays open.
      await expect(
        planSessionEndService.endSession(session.id, 'failed', { workspaceId: rival.workspaceId }),
      ).rejects.toBeInstanceOf(PlanChangeSessionNotFoundError);
      expect((await endOf(session.id)).endedAt).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);

      // HOLD: the other project resolves none of this one's keys, so it is told
      // nothing about who holds them.
      expect(await planTargetLockService.readForeignHoldForScope([card.key], me(rival))).toBeNull();

      // COPY: once ended, the source is still nobody else's to copy.
      await planSessionEndService.endSession(session.id, 'failed', {
        workspaceId: fx.workspaceId,
      });
      await expect(
        planChangeSessionsService.startCopied(me(rival), session.id),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
      expect(
        await adminDb.planChangeSession.count({ where: { copiedFromSessionId: session.id } }),
      ).toBe(0);

      // The rival's own idle session is closed by the same sweep, under its own
      // tenant, and this one's card is not touched by it.
      const theirs = await openOn(await seedCard(rival), rival);
      await adminDb.planChangeSession.update({
        where: { id: theirs.id },
        data: { lastActivityAt: new Date(Date.now() - PLAN_TARGET_LOCK_LEASE_MS - HOUR) },
      });
      const out = await planSessionEndService.closeIdleSessions();
      expect(out.sessionIds).toEqual([theirs.id]);
      expect((await endOf(theirs.id)).endReason).toBe('idle');
    },
  );
});

describe('the whole journey: a failure closes it, and the conversation carries on', () => {
  it(
    'fail → card back → copyable → Start a new session → the next turn takes the card',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const first = await openOn(card);
      await adminDb.planChangeSession.update({
        where: { id: first.id },
        data: { lastJobId: 'job-fails' },
      });

      // The relay sees the terminal frame.
      await planSessionEndService.endSessionForFailedJob('job-fails', {
        ...fx.ctx,
        projectId: fx.projectId,
      });
      expect((await endOf(first.id)).endReason).toBe('failed');
      expect(await statusOf(card.id)).toBe('in_progress');

      // The resume names it as copyable — and resumes nothing.
      const read = await planChangeSessionsService.findResumableWithEarlier(
        me(),
        buildScope([card.key]).scopeKey,
      );
      expect(read.session).toBeNull();
      expect(read.copyable?.id).toBe(first.id);

      // Start a new session: the turns come across, nothing is sent, nothing held.
      const copy = await planChangeSessionsService.startCopied(me(), first.id);
      expect(copy.copiedFromSessionId).toBe(first.id);
      expect(copy.turns.map((t) => t.body)).toEqual(['Split it']);
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await statusOf(card.id)).toBe('in_progress');

      // The next turn lands on the COPY, and it is the copy that holds the card.
      const next = await openOn(card);
      expect(next.id).toBe(copy.id);
      expect(next.turns.map((t) => t.body)).toEqual(['Split it', 'Split it']);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      const lock = await adminDb.planTargetLock.findUniqueOrThrow({
        where: { workItemId: card.id },
      });
      expect(lock.sessionId).toBe(copy.id);
    },
  );
});

describe('the ends that end NOTHING', () => {
  it(
    'an unknown session, an unowned job and a plan that is not the attempt’s latest',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      await expect(
        planSessionEndService.endSession('no-such-session', 'failed', {
          workspaceId: fx.workspaceId,
        }),
      ).rejects.toBeInstanceOf(PlanChangeSessionNotFoundError);
      expect(
        await planSessionEndService.endSessionForFailedJob('no-such-job', {
          ...fx.ctx,
          projectId: fx.projectId,
        }),
      ).toBeNull();
      // A plan with no session (a work item's contextual plan) ends nothing.
      expect(
        await planSessionEndService.endSessionForAbandonedPlan({
          id: 'plan-x',
          workspaceId: fx.workspaceId,
          sessionId: null,
        }),
      ).toBeNull();

      // A session that moved on to a NEWER plan is not the old attempt's to end.
      const card = await seedCard();
      const session = await openOn(card);
      const older = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId: session.id,
          status: 'generating',
          createdAt: new Date(Date.now() - 72 * HOUR),
        },
      });
      await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId: session.id,
          status: 'generating',
        },
      });
      expect(
        await planSessionEndService.endSessionForAbandonedPlan({
          id: older.id,
          workspaceId: fx.workspaceId,
          sessionId: session.id,
        }),
      ).toBeNull();
      expect((await endOf(session.id)).endedAt).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});

describe('a PERSON’s end is signed by them', () => {
  it(
    'a restart names who restarted it and gives the card back under their signature',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const session = await openOn(card);

      // The restart door (MOTIR-7631) is a person's end that owns its release; a
      // decision's release is the plan decision's own, not the end operation's.
      const out = await planSessionEndService.endSession(session.id, 'restarted', {
        workspaceId: fx.workspaceId,
        endedById: fx.ownerId,
        actorId: fx.ownerId,
      });

      expect(out.ended).toBe(true);
      expect(await endOf(session.id)).toMatchObject({
        endReason: 'restarted',
        endedById: fx.ownerId,
      });
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );
});

describe('a session nobody started is still ended by Motir', () => {
  it(
    'the workspace’s stand-in manager signs the restores when the starter is gone',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const session = await openOn(card);
      await adminDb.planChangeSession.update({
        where: { id: session.id },
        data: { createdById: null },
      });

      const out = await planSessionEndService.endSession(session.id, 'failed', {
        workspaceId: fx.workspaceId,
      });

      expect(out.ended).toBe(true);
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );
});
