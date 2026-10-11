import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import {
  NotSessionOwnerError,
  PlanNotResumableError,
  PlanSessionAwaitingResumeError,
  PlanSessionEndedError,
  ResumeAlreadyStartedError,
  SessionNotFailedError,
  GuideSessionNotPlannableError,
} from '@/lib/planChange/errors';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { planRepository } from '@/lib/repositories/planRepository';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { MotirAiOutOfCreditsError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { RECORD_PLANNING_MISTAKES_CONTEXT_FIELD } from '@/lib/ai/lessonCapture';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// RESUMING A FAILED PLANNING SESSION (Story MOTIR-7905 · MOTIR-7916), against a REAL Postgres,
// with motir-ai stubbed at `submitJob`: the same plan in the same session, the failure cleared
// at the bind, the targets heartbeated, a second failure recordable, every refusal costing
// nothing, and the two races (a double Resume, a Resume against an end) deterministic.

const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
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

const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const T = { timeout: 120_000 };
let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  submitJobMock.mockReset();
  jobSeq = 0;
  submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (f: WorkItemFixture = fx): ProjectContext => ({
  userId: f.ownerId,
  workspaceId: f.workspaceId,
  projectId: f.projectId,
  project: f.project,
});
const asUser = (userId: string): ProjectContext => ({ ...me(), userId });

async function seedCard() {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

/** A failed-waiting session with its `generating` plan and a held card, built the real way. */
async function failedSession(opts: { proposals?: number } = {}) {
  const card = await seedCard();
  const session = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([card.key]),
    'Split it',
  );
  await adminDb.planChangeSession.update({
    where: { id: session.id },
    data: {
      lastJobId: 'job-1',
      failedAt: new Date(),
      failedJobId: 'job-1',
      failureReason: 'rate_limited',
      failureStopPhase: 'author',
      failureStopRef: 'planItem:abc',
      failureStopTitle: 'Export',
    },
  });
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'generating',
      sourceJobId: 'job-1',
      createdById: fx.ownerId,
    },
  });
  for (let i = 0; i < (opts.proposals ?? 2); i++) {
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: 'add',
        proposedFields: { title: `P${i}`, kind: 'subtask' },
        blockedByRefs: [],
      },
    });
  }
  return { sessionId: session.id, planId: plan.id, card };
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const findBySourceJob = (jobId: string) =>
  withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planRepository.findBySourceJobId(jobId, fx.workspaceId, tx),
  );

describe('the happy path — the SAME plan in the SAME session', () => {
  it('submits a resume, re-binds the plan, clears the failure and keeps the cards', T, async () => {
    const f = await failedSession();
    const lockBefore = await adminDb.planTargetLock.findFirstOrThrow({
      where: { sessionId: f.sessionId },
    });

    const out = await planSessionResumeService.resume(me(), f.sessionId);

    // motir-ai got a `plan` job carrying the resume, and the always-present context fields.
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [kind, , context, , opts] = submitJobMock.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
      unknown,
      { resume?: unknown },
    ];
    expect(kind).toBe('plan');
    expect(opts.resume).toEqual({ planId: f.planId, fromJobId: 'job-1' });
    expect(context).toHaveProperty('generateExplanations');
    expect(context).toHaveProperty(RECORD_PLANNING_MISTAKES_CONTEXT_FIELD);
    expect(context).not.toHaveProperty('planId');

    expect(out).toMatchObject({ jobId: 'job-new-1', planId: f.planId });
    const plan = await planRow(f.planId);
    expect(plan.status).toBe('generating');
    expect(plan.sourceJobId).toBe('job-new-1');
    expect(await adminDb.planItem.count({ where: { planId: f.planId } })).toBe(2);
    const s = await sessionRow(f.sessionId);
    expect(s.endedAt).toBeNull();
    expect(s.lastJobId).toBe('job-new-1');
    expect(sessionWaitingState(s)).toBe('open');
    expect(
      [s.failedAt, s.failedJobId, s.failureReason, s.failureDetail, s.failureStopPhase].every(
        (v) => v === null,
      ),
    ).toBe(true);
    expect((await findBySourceJob('job-new-1'))?.id).toBe(f.planId);
    expect(await findBySourceJob('job-1')).toBeNull();
    // The session's targets are still held, and their lease was refreshed.
    const lockAfter = await adminDb.planTargetLock.findFirstOrThrow({
      where: { sessionId: f.sessionId },
    });
    expect(lockAfter.expiresAt.getTime()).toBeGreaterThanOrEqual(lockBefore.expiresAt.getTime());
    expect(out.session.id).toBe(f.sessionId);
  });

  it(
    'a second failure records its new reason; the OLD job’s late frame writes nothing',
    T,
    async () => {
      const f = await failedSession();
      await planSessionResumeService.resume(me(), f.sessionId);

      await planSessionEndService.settleFailedJob(
        'job-new-1',
        { ...fx.ctx, projectId: fx.projectId },
        { status: 'failed' },
        {
          readJob: async () => ({
            error: null,
            walkStop: {
              phase: 'lay',
              target: null,
              targetTitle: null,
              depth: 0,
              reasonCode: 'out_of_credits',
            },
          }),
        },
      );
      const afterSecond = await sessionRow(f.sessionId);
      expect(afterSecond.failedJobId).toBe('job-new-1');
      expect(afterSecond.failureReason).toBe('out_of_credits');
      expect(afterSecond.endedAt).toBeNull();

      const late = await planSessionEndService.settleFailedJob(
        'job-1',
        { ...fx.ctx, projectId: fx.projectId },
        { status: 'failed' },
      );
      expect(late).toBeNull();
      expect((await sessionRow(f.sessionId)).failedJobId).toBe('job-new-1');
    },
  );
});

describe('every refusal costs nothing', () => {
  async function expectRefusal(
    run: () => Promise<unknown>,
    error: new (...args: never[]) => Error,
    f: { sessionId: string; planId: string },
  ) {
    const before = [await sessionRow(f.sessionId), await planRow(f.planId)];
    await expect(run()).rejects.toBeInstanceOf(error);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect([await sessionRow(f.sessionId), await planRow(f.planId)]).toEqual(before);
  }

  it('a non-owner member with `ai:plan` is refused NOT_SESSION_OWNER', T, async () => {
    const f = await failedSession();
    const other = await createTestUser({ name: 'Other' });
    await workspacesService.addMember({
      userId: other.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });

    await expectRefusal(
      () => planSessionResumeService.resume(asUser(other.id), f.sessionId),
      NotSessionOwnerError,
      f,
    );
  });

  it('a project manager (`ai:configure`) CAN resume another member’s session', T, async () => {
    const f = await failedSession();
    const manager = await createTestUser({ name: 'Manager' });
    await workspacesService.addMember({
      userId: manager.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'manager',
    });

    const out = await planSessionResumeService.resume(asUser(manager.id), f.sessionId);

    expect(out.planId).toBe(f.planId);
    expect((await sessionRow(f.sessionId)).failedAt).toBeNull();
    expect((await sessionRow(f.sessionId)).createdById).toBe(fx.ownerId);
  });

  it('an ended session is refused', T, async () => {
    const f = await failedSession();
    await planSessionEndService.endSession(f.sessionId, 'restarted', {
      workspaceId: fx.workspaceId,
      endedById: fx.ownerId,
      actorId: fx.ownerId,
    });
    submitJobMock.mockClear();

    await expect(planSessionResumeService.resume(me(), f.sessionId)).rejects.toBeInstanceOf(
      PlanSessionEndedError,
    );
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('an open session that is not failed is refused SESSION_NOT_FAILED', T, async () => {
    const f = await failedSession();
    await adminDb.planChangeSession.update({
      where: { id: f.sessionId },
      data: {
        failedAt: null,
        failedJobId: null,
        failureReason: null,
        failureStopPhase: null,
        failureStopRef: null,
        failureStopTitle: null,
      },
    });

    await expectRefusal(
      () => planSessionResumeService.resume(me(), f.sessionId),
      SessionNotFailedError,
      f,
    );
  });

  it('a guide session is refused', T, async () => {
    const f = await failedSession();
    await adminDb.planChangeSession.update({
      where: { id: f.sessionId },
      data: { origin: 'guide' },
    });

    await expectRefusal(
      () => planSessionResumeService.resume(me(), f.sessionId),
      GuideSessionNotPlannableError,
      f,
    );
  });

  it.each([
    ['a plan that is no longer generating', { status: 'planned' as const }],
    ['a plan written by another job', { sourceJobId: 'job-other' }],
  ])('%s is refused PLAN_NOT_RESUMABLE', T, async (_name, patch) => {
    const f = await failedSession();
    await adminDb.plan.update({ where: { id: f.planId }, data: patch });

    await expectRefusal(
      () => planSessionResumeService.resume(me(), f.sessionId),
      PlanNotResumableError,
      f,
    );
  });

  it('a caller without `ai:plan` is refused with the permission error', T, async () => {
    const f = await failedSession();
    const outsider = await createTestUser({ name: 'Outsider' });

    await expect(
      planSessionResumeService.resume(asUser(outsider.id), f.sessionId),
    ).rejects.toBeInstanceOf(Error);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(sessionWaitingState(await sessionRow(f.sessionId))).toBe('failed');
  });
});

describe('a submit that fails leaves the failure exactly as it was', () => {
  it.each([
    ['out of credits', new MotirAiOutOfCreditsError('no credits')],
    ['unreachable', new MotirAiUnavailableError('down')],
  ])('%s', T, async (_name, error) => {
    const f = await failedSession();
    submitJobMock.mockRejectedValueOnce(error);
    const before = [await sessionRow(f.sessionId), await planRow(f.planId)];

    await expect(planSessionResumeService.resume(me(), f.sessionId)).rejects.toBe(error);

    expect([await sessionRow(f.sessionId), await planRow(f.planId)]).toEqual(before);
  });
});

describe('the ordinary submit refuses on a failed-waiting session', () => {
  it('opens no second plan and submits no job', T, async () => {
    const f = await failedSession();

    await expect(
      planChangeSessionsService.submit(me(), { sessionId: f.sessionId }),
    ).rejects.toBeInstanceOf(PlanSessionAwaitingResumeError);

    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await adminDb.plan.count({ where: { sessionId: f.sessionId } })).toBe(1);
  });

  it(
    'still submits on an open session that is not failed, and on an awaiting-person one',
    T,
    async () => {
      submitJobMock.mockResolvedValue({ jobId: 'job-ordinary' });
      const open = await failedSession();
      await adminDb.planChangeSession.update({
        where: { id: open.sessionId },
        data: {
          failedAt: null,
          failedJobId: null,
          failureReason: null,
          failureStopPhase: null,
          failureStopRef: null,
          failureStopTitle: null,
        },
      });
      const awaiting = await failedSession();
      await adminDb.planChangeSession.update({
        where: { id: awaiting.sessionId },
        data: {
          failedAt: null,
          failedJobId: null,
          failureReason: null,
          failureStopPhase: null,
          failureStopRef: null,
          failureStopTitle: null,
          awaitingPersonSince: new Date(),
          awaitingPersonCause: 'question',
        },
      });

      for (const id of [open.sessionId, awaiting.sessionId]) {
        const out = await planChangeSessionsService.submit(me(), { sessionId: id });
        expect(out.jobId).toBe('job-ordinary');
      }
    },
  );
});

describe('real concurrency', () => {
  it(
    'two Resumes on one failed session, 20 times: one bind lands, the other is RESUME_ALREADY_STARTED',
    { timeout: 300_000 },
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        submitJobMock.mockReset();
        jobSeq = 0;
        submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
        const f = await failedSession();

        const results = await Promise.allSettled([
          planSessionResumeService.resume(me(), f.sessionId),
          planSessionResumeService.resume(me(), f.sessionId),
        ]);

        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        const reason = (lost[0] as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(ResumeAlreadyStartedError);
        const winner = (won[0] as PromiseFulfilledResult<{ jobId: string }>).value.jobId;
        expect((reason as ResumeAlreadyStartedError).jobId).toBe(winner);
        const s = await sessionRow(f.sessionId);
        expect(s.lastJobId).toBe(winner);
        expect((await planRow(f.planId)).sourceJobId).toBe(winner);
        expect(sessionWaitingState(s)).toBe('open');
      }
    },
  );

  it(
    'a Resume racing a person’s restart, 20 times: ended and not re-bound, or open and re-bound — never both',
    { timeout: 300_000 },
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        submitJobMock.mockReset();
        jobSeq = 0;
        submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
        const f = await failedSession();

        await Promise.allSettled([
          planSessionResumeService.resume(me(), f.sessionId),
          planSessionEndService.endSession(f.sessionId, 'restarted', {
            workspaceId: fx.workspaceId,
            endedById: fx.ownerId,
            actorId: fx.ownerId,
          }),
        ]);

        const s = await sessionRow(f.sessionId);
        const plan = await planRow(f.planId);
        if (s.endedAt) {
          // Ended: the failure is cleared with the end, and the plan is as the end left it.
          expect(s.failedAt).toBeNull();
          expect(plan.sourceJobId === 'job-1' || plan.sourceJobId === 'job-new-1').toBe(true);
          expect(s.lastJobId === 'job-1' || s.lastJobId === 'job-new-1').toBe(true);
          // …and never bound to the new job while ending the session under it.
          if (plan.status === 'generating') expect(plan.sourceJobId).toBe(s.lastJobId);
        } else {
          expect(s.lastJobId).toBe('job-new-1');
          expect(plan.sourceJobId).toBe('job-new-1');
          expect(s.failedAt).toBeNull();
        }
      }
    },
  );
});
