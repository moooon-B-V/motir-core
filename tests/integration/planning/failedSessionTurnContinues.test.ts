import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PlanSessionAwaitingResumeError, PlanSessionEndedError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE NEXT TURN ON A FAILED SESSION WHOSE PLAN WAITS CONTINUES THERE (Story MOTIR-7905 ·
// MOTIR-7938), against a REAL Postgres; only the motir-ai client is stubbed.

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-r${++jobSeq}` }));

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

const T = { timeout: 120_000 };
const RACE_ITERATIONS = 20;

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-r${++jobSeq}` }));
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

const readJob = async () => ({ error: { code: 'rate_limited' }, walkStop: null });

/** An open conversation holding a `planned` plan, then FAILED beside it (`failedJobId`). */
async function failedBesidePlannedPlan() {
  const target = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
    fx.ctx,
  );
  await adminDb.planChangeSession.updateMany({
    where: { endedAt: null },
    data: { endedAt: new Date(), endReason: 'restarted' },
  });
  const s = await planChangeSessionsService.startWithFirstTurn(me(), PROJECT_SCOPE, 'Rework it');
  const first = await planChangeSessionsService.submit(me(), { sessionId: s.id });
  await plansService.addProposals(
    first.planId,
    [{ op: 'modify' as const, workItemId: target.id, patch: { title: 'New' } }],
    fx.ctx,
  );
  await plansService.markPlanned(first.planId, fx.ctx);
  await adminDb.planChangeSession.update({
    where: { id: s.id },
    data: {
      failedAt: new Date(),
      failedJobId: 'job-f',
      failureReason: 'rate_limited',
    },
  });
  await planChangeSessionsService.appendTurn('Change it', me(), { sessionId: s.id });
  return { sessionId: s.id, planId: first.planId };
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });

describe('a turn on a failed session whose plan waits', () => {
  it('revises the plan in the same session and clears the failure', T, async () => {
    const { sessionId, planId } = await failedBesidePlannedPlan();
    const sessionsBefore = await adminDb.planChangeSession.count();

    const out = await planChangeSessionsService.submit(me(), { sessionId });

    expect(out.planId).toBe(planId);
    expect(await adminDb.plan.count({ where: { sessionId } })).toBe(1);
    expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore);
    const s = await sessionRow(sessionId);
    expect(s.failedAt).toBeNull();
    expect(s.failedJobId).toBeNull();
    expect(s.failureReason).toBeNull();
    expect(s.lastJobId).toBe(out.jobId);
    expect(s.endedAt).toBeNull();
  });

  it('the revision’s own failure records again and releases its lease', T, async () => {
    const { sessionId, planId } = await failedBesidePlannedPlan();
    const out = await planChangeSessionsService.submit(me(), { sessionId });

    const settled = await planSessionEndService.settleFailedJob(
      out.jobId,
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      { status: 'failed' },
      { readJob },
    );

    expect(settled?.settled).toBe('recorded');
    expect((await sessionRow(sessionId)).failedJobId).toBe(out.jobId);
    expect(await plansService.readRevisionLease(planId, me())).toBeNull();
    // …and the OLD failed job writes nothing.
    expect(
      await planSessionEndService.settleFailedJob(
        'job-f',
        { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
        { status: 'failed' },
        { readJob },
      ),
    ).toBeNull();
    await plansService.approvePlan(planId, fx.ctx);
  });

  it(
    'a failed walk still refuses an ordinary turn, with and without a waiting plan',
    T,
    async () => {
      const { sessionId } = await failedBesidePlannedPlan();
      await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId,
          status: 'generating',
          sourceJobId: 'job-f',
          createdById: fx.ownerId,
        },
      });
      submitJobMock.mockClear();

      await expect(planChangeSessionsService.submit(me(), { sessionId })).rejects.toBeInstanceOf(
        PlanSessionAwaitingResumeError,
      );
      expect(submitJobMock).not.toHaveBeenCalled();
      expect((await sessionRow(sessionId)).failedJobId).toBe('job-f');
    },
  );

  it('a failed submit leaves the record, lastJobId and turn count unchanged', T, async () => {
    const { sessionId } = await failedBesidePlannedPlan();
    const before = await sessionRow(sessionId);
    submitJobMock.mockRejectedValueOnce(new Error('unreachable'));

    await expect(planChangeSessionsService.submit(me(), { sessionId })).rejects.toThrow();

    const after = await sessionRow(sessionId);
    expect(after.failedJobId).toBe('job-f');
    expect(after.lastJobId).toBe(before.lastJobId);
    expect(after.turnCount).toBe(before.turnCount);
  });

  it('two parallel turns clear the failure once and bind one marker (x20)', T, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const { sessionId } = await failedBesidePlannedPlan();
      const markersBefore = await adminDb.planChangeTurn.count({
        where: { sessionId, role: 'system' },
      });

      const results = await Promise.allSettled([
        planChangeSessionsService.submit(me(), { sessionId }),
        planChangeSessionsService.submit(me(), { sessionId }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await sessionRow(sessionId)).failedAt).toBeNull();
      expect(await adminDb.planChangeTurn.count({ where: { sessionId, role: 'system' } })).toBe(
        markersBefore + 1,
      );
    }
  });

  it('a turn racing a restart never ends AND clears (x20)', T, async () => {
    for (let i = 0; i < RACE_ITERATIONS; i++) {
      const { sessionId } = await failedBesidePlannedPlan();

      const [turn] = await Promise.allSettled([
        planChangeSessionsService.submit(me(), { sessionId }),
        planSessionEndService.endSession(sessionId, 'restarted', {
          workspaceId: fx.workspaceId,
          endedById: fx.ownerId,
          actorId: fx.ownerId,
        }),
      ]);

      const s = await sessionRow(sessionId);
      if (turn.status === 'fulfilled') {
        // The turn bound first: the failure is cleared. (The restart then ended an open session.)
        expect(s.failedAt).toBeNull();
      } else {
        expect(turn.reason).toBeInstanceOf(PlanSessionEndedError);
        expect(s.endedAt).not.toBeNull();
        expect(s.failedAt).toBeNull(); // the end nulls the record itself
      }
    }
  });
});
