import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE, buildScope } from '@/lib/planChange/scope';
import {
  PlanAgainNotAvailableError,
  PlanSessionEndedError,
  PlanSessionPlanDecidedError,
  PlanSessionPlanStaleError,
} from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { planDriftService } from '@/lib/services/planDriftService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A TURN ON A CONVERSATION WHOSE PLAN WAITS (MOTIR-7945; origin bug MOTIR-7927),
// against a REAL Postgres. Only the motir-ai boundary client is stubbed; the
// revision lease, the session lock, the drift move and the claim run for real.

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-${++jobSeq}` }));

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
const { mapPlanChangeError } = await import('@/app/api/ai/plan-change/_errors');

const DB_TEST_TIMEOUT_MS = 120_000;
const RACE_ITERATIONS = 20;

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
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

async function card(title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** An open project-wide conversation whose plan proposes to `modify` each of
 *  `targets` and has reached `planned` through the shipped doors. */
async function conversationWithPlannedPlan(targets: string[]) {
  // One OPEN session per scope: close the previous fixture's so a fresh one opens.
  await adminDb.planChangeSession.updateMany({
    where: { endedAt: null },
    data: { endedAt: new Date(), endReason: 'restarted' },
  });
  const s = await planChangeSessionsService.startWithFirstTurn(
    me(),
    PROJECT_SCOPE,
    'Rework the exports',
  );
  const first = await planChangeSessionsService.submit(me(), { sessionId: s.id });
  await plansService.addProposals(
    first.planId,
    targets.map((workItemId) => ({ op: 'modify' as const, workItemId, patch: { title: 'New' } })),
    fx.ctx,
  );
  await plansService.markPlanned(first.planId, fx.ctx);
  return { sessionId: s.id, planId: first.planId };
}

/** Finish a target through the drift move, turning its plan `stale`. */
async function finish(workItemId: string) {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status: 'done' } });
  await planDriftService.markStaleForTerminalTarget(workItemId, fx.workspaceId, {
    fromStatusKey: 'todo',
    toStatusKey: 'done',
  });
}

async function revive(workItemId: string) {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status: 'in_progress' } });
  await planDriftService.restoreForRevivedTarget(workItemId, fx.workspaceId, {
    fromStatusKey: 'done',
    toStatusKey: 'in_progress',
  });
}

async function say(sessionId: string, body: string) {
  await planChangeSessionsService.appendTurn(body, me(), { sessionId });
}

const plansIn = (sessionId: string) => adminDb.plan.count({ where: { sessionId } });
const markers = (sessionId: string) =>
  adminDb.planChangeTurn.count({ where: { sessionId, role: 'system' } });
const trail = (planId: string, changeKind: string) =>
  adminDb.planRevision.findMany({ where: { planId, changeKind }, orderBy: { changedAt: 'asc' } });

describe('a turn over a PLANNED plan revises it', () => {
  it(
    'returns that plan, opens no second one, and binds the turn to the session',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('CSV export');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await say(sessionId, 'Keep the PDF report');
      const markersBefore = await markers(sessionId);

      const out = await planChangeSessionsService.submit(me(), { sessionId });

      expect(out.planId).toBe(planId);
      expect(await plansIn(sessionId)).toBe(1);
      const started = await trail(planId, 'revision_started');
      expect(started).toHaveLength(1);
      expect((started[0]!.diff as { jobId: string }).jobId).toBe(out.jobId);
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      expect(plan.sourceJobId).toBe(out.jobId);
      const session = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.lastJobId).toBe(out.jobId);
      expect(await markers(sessionId)).toBe(markersBefore + 1);
      expect(await adminDb.planChangeSession.count()).toBe(1);
      expect(await plansService.readRevisionLease(planId, me())).not.toBeNull();
      // The revise prompt carries the plan, not a new plan's scope.
      const lastCall = submitJobMock.mock.calls.at(-1) as unknown as [
        string,
        unknown,
        { planId?: string },
      ];
      expect(lastCall[2].planId).toBe(planId);
    },
  );

  it(
    'a session whose latest undecided plan is generating, or that has none, opens a new plan as today',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const augment = vi.spyOn(aiPlanEditsService, 'submitAugment');
      const s = await planChangeSessionsService.startWithFirstTurn(me(), PROJECT_SCOPE, 'Start');
      const a = await planChangeSessionsService.submit(me(), { sessionId: s.id });
      await say(s.id, 'And more');
      const b = await planChangeSessionsService.submit(me(), { sessionId: s.id });
      expect(b.planId).not.toBe(a.planId);
      expect(augment).toHaveBeenCalledTimes(2);
      expect(await plansIn(s.id)).toBe(2);

      const contextual = vi.spyOn(aiPlanEditsService, 'submitContextual');
      const anchor = await card('Anchored');
      const anchored = await planChangeSessionsService.startWithFirstTurn(
        me(),
        buildScope([anchor.identifier]),
        'Split it',
      );
      await planChangeSessionsService.submit(me(), { sessionId: anchored.id });
      expect(contextual).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'two sends at once over a planned plan bind ONE turn and one lease',
    { timeout: DB_TEST_TIMEOUT_MS * 3 },
    async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const target = await card(`Race ${i}`);
        const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
        await say(sessionId, 'Change it');
        const markersBefore = await markers(sessionId);

        const results = await Promise.allSettled([
          planChangeSessionsService.submit(me(), { sessionId }),
          planChangeSessionsService.submit(me(), { sessionId }),
        ]);

        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(((lost[0] as PromiseRejectedResult).reason as { code?: string }).code).toBe(
          'PLAN_REVISION_IN_FLIGHT',
        );
        expect(await markers(sessionId)).toBe(markersBefore + 1);
        expect(await trail(planId, 'revision_started')).toHaveLength(1);
        expect(await plansIn(sessionId)).toBe(1);
      }
    },
  );

  it(
    'a send racing approve never leaves an approved plan under a lease',
    { timeout: DB_TEST_TIMEOUT_MS * 3 },
    async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const target = await card(`Approve race ${i}`);
        const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
        await say(sessionId, 'One more change');

        const [send, approve] = await Promise.allSettled([
          planChangeSessionsService.submit(me(), { sessionId }),
          plansService.approvePlan(planId, fx.ctx),
        ]);

        expect([send.status, approve.status].filter((s) => s === 'rejected')).toHaveLength(1);
        const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
        const leased = await plansService.readRevisionLease(planId, me());
        expect(plan.status === 'approved' && leased !== null).toBe(false);
      }
    },
  );

  it(
    'a session ended between the submit and the bind takes no turn and gives the lease back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('Ends mid-send');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await say(sessionId, 'Change it');
      const markersBefore = await markers(sessionId);
      submitJobMock.mockImplementationOnce(async () => {
        await adminDb.planChangeSession.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), endReason: 'idle' },
        });
        return { jobId: 'job-ended-window' };
      });

      await expect(planChangeSessionsService.submit(me(), { sessionId })).rejects.toBeInstanceOf(
        PlanSessionEndedError,
      );
      expect(await markers(sessionId)).toBe(markersBefore);
      const ended = await trail(planId, 'revision_ended');
      expect(ended).toHaveLength(1);
      expect(ended[0]!.diff).toMatchObject({ jobId: 'job-ended-window', reason: 'session_ended' });
      expect(await plansService.readRevisionLease(planId, me())).toBeNull();
    },
  );

  it(
    'a failed revision job releases its lease and the plan stays planned',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('Fails');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await say(sessionId, 'Change it');
      const out = await planChangeSessionsService.submit(me(), { sessionId });

      await planSessionEndService.settleFailedJob(
        out.jobId,
        { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
        { status: 'failed' },
        { readJob: async () => ({ error: { code: 'rate_limited' }, walkStop: null }) },
      );

      const ended = await trail(planId, 'revision_ended');
      expect(ended).toHaveLength(1);
      expect(ended[0]!.diff).toMatchObject({ jobId: out.jobId, failed: true });
      expect(await plansService.readRevisionLease(planId, me())).toBeNull();
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'planned',
      );
      // The failure is RECORDED on the session, which stays open beside its plan
      // (MOTIR-7905 · MOTIR-7936) — it is no longer ended.
      const after = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(after.endedAt).toBeNull();
      expect(after.failedJobId).toBe(out.jobId);
    },
  );
});

describe('a turn over a STALE plan is the stale outcome', () => {
  it(
    'names the finished cards in key order, spends nothing and writes nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const a = await card('First finished');
      const b = await card('Second finished');
      const live = await card('Still open');
      const { sessionId, planId } = await conversationWithPlannedPlan([b.id, live.id, a.id]);
      await finish(b.id);
      await adminDb.workItem.update({ where: { id: a.id }, data: { status: 'done' } });
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'stale',
      );
      await say(sessionId, 'Change it anyway');
      const before = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const itemsBefore = await adminDb.planItem.count({ where: { planId } });
      submitJobMock.mockClear();

      const err = await planChangeSessionsService
        .submit(me(), { sessionId })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PlanSessionPlanStaleError);
      const stale = err as PlanSessionPlanStaleError;
      expect(stale.planId).toBe(planId);
      expect(stale.finishedCards.map((c) => c.key)).toEqual([a.identifier, b.identifier]);
      expect(stale.finishedCards[0]).toMatchObject({ title: 'First finished', status: 'done' });
      expect(submitJobMock).not.toHaveBeenCalled();
      const after = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(after.lastJobId).toBe(before.lastJobId);
      expect(after.lastSubmittedAt).toEqual(before.lastSubmittedAt);
      const newest = await adminDb.planChangeTurn.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
      });
      expect(newest?.role).toBe('user');
      expect(await trail(planId, 'revision_started')).toHaveLength(0);
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'stale',
      );
      expect(await adminDb.planItem.count({ where: { planId } })).toBe(itemsBefore);
      expect(await plansIn(sessionId)).toBe(1);

      const res = mapPlanChangeError(err)!;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'PLAN_SESSION_PLAN_STALE',
        planId,
        finishedCards: [{ key: a.identifier }, { key: b.identifier }],
      });
    },
  );

  it(
    'Plan it again opens ONE fresh plan and leaves the stale plan as it was',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const augment = vi.spyOn(aiPlanEditsService, 'submitAugment');
      const target = await card('Done meanwhile');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await finish(target.id);
      await say(sessionId, 'Make the import faster');
      await planChangeSessionsService.submit(me(), { sessionId }).catch(() => undefined);
      augment.mockClear();

      const out = await planChangeSessionsService.submit(me(), { sessionId }, undefined, {
        planAgainOf: planId,
      });

      expect(out.planId).not.toBe(planId);
      expect(augment).toHaveBeenCalledTimes(1);
      expect(augment.mock.calls[0]![0]).toContain('Make the import faster');
      expect(await plansIn(sessionId)).toBe(2);
      const stale = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      expect(stale).toMatchObject({ status: 'stale', sessionId });
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: out.planId } })).status).toBe(
        'generating',
      );
      const session = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.lastJobId).toBe(out.jobId);

      // Once the new plan is planned, the next turn revises IT.
      const other = await card('Import speed');
      await plansService.addProposals(
        out.planId,
        [{ op: 'modify', workItemId: other.id, patch: { title: 'Faster import' } }],
        fx.ctx,
      );
      await plansService.markPlanned(out.planId, fx.ctx);
      await say(sessionId, 'Tweak it');
      const next = await planChangeSessionsService.submit(me(), { sessionId });
      expect(next.planId).toBe(out.planId);
    },
  );

  it(
    'two accepts at once make one job and one plan',
    { timeout: DB_TEST_TIMEOUT_MS * 3 },
    async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const target = await card(`Accept race ${i}`);
        const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
        await finish(target.id);
        await say(sessionId, 'Again please');
        submitJobMock.mockClear();
        const markersBefore = await markers(sessionId);

        const results = await Promise.allSettled([
          planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
          planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
        ]);

        const lost = results.filter((r) => r.status === 'rejected');
        expect(lost).toHaveLength(1);
        expect(((lost[0] as PromiseRejectedResult).reason as { code?: string }).code).toBe(
          'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE',
        );
        expect(submitJobMock).toHaveBeenCalledTimes(1);
        expect(await plansIn(sessionId)).toBe(2);
        expect(await markers(sessionId)).toBe(markersBefore + 1);
      }
    },
  );

  it(
    'an accept after the plan was restored revises it instead',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('Reopened');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await finish(target.id);
      await say(sessionId, 'Again');
      await revive(target.id);
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'planned',
      );

      const out = await planChangeSessionsService.submit(me(), { sessionId }, undefined, {
        planAgainOf: planId,
      });

      expect(out.planId).toBe(planId);
      expect(await plansIn(sessionId)).toBe(1);
      expect(await trail(planId, 'revision_started')).toHaveLength(1);
    },
  );

  it(
    'an accept after the plan was declined is refused and writes nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('Declined meanwhile');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await finish(target.id);
      await say(sessionId, 'Again');
      await plansService.declinePlan(planId, fx.ctx);
      submitJobMock.mockClear();
      const turnsBefore = await adminDb.planChangeTurn.count({ where: { sessionId } });

      await expect(
        planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
      ).rejects.toBeInstanceOf(PlanSessionPlanDecidedError);
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await adminDb.planChangeTurn.count({ where: { sessionId } })).toBe(turnsBefore);
      expect(await plansIn(sessionId)).toBe(1);
    },
  );

  it(
    'a failed accept gives its claim back, so a second accept succeeds',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('Unreachable planner');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await finish(target.id);
      await say(sessionId, 'Again');
      const before = (
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })
      ).lastSubmittedAt;
      submitJobMock.mockRejectedValueOnce(new Error('motir-ai unreachable'));

      await expect(
        planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
      ).rejects.toThrow('motir-ai unreachable');
      expect(
        (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } }))
          .lastSubmittedAt,
      ).toEqual(before);
      expect(await plansIn(sessionId)).toBe(1);

      const out = await planChangeSessionsService.submit(me(), { sessionId }, undefined, {
        planAgainOf: planId,
      });
      expect(out.planId).not.toBe(planId);
    },
  );

  it(
    'an accept naming a plan the conversation has moved past is superseded',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('Moved past');
      const { sessionId, planId } = await conversationWithPlannedPlan([target.id]);
      await finish(target.id);
      await say(sessionId, 'Again');
      const again = await planChangeSessionsService.submit(me(), { sessionId }, undefined, {
        planAgainOf: planId,
      });

      const err = await planChangeSessionsService
        .submit(me(), { sessionId }, undefined, { planAgainOf: planId })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanAgainNotAvailableError);
      expect((err as PlanAgainNotAvailableError).latestPlanId).toBe(again.planId);
    },
  );
});
