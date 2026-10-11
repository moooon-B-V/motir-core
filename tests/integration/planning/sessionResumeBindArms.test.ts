import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import {
  PlanNotResumableError,
  PlanSessionEndedError,
  PlanSessionNotFoundError,
  ResumeAlreadyStartedError,
} from '@/lib/planChange/errors';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE RESUME BIND'S REFUSALS (Story MOTIR-7905 · MOTIR-7916 / MOTIR-7919), against a REAL Postgres.
// `bind` re-reads everything under the plan and session locks, because the pre-check ran in
// another transaction: each refusal below is a state that can only appear BETWEEN the two. The
// real repositories run; one call is made to answer as the racing writer would have left the row,
// and the bind has to refuse with its typed error and write nothing.

const submitJobMock = vi.fn(async () => ({ jobId: 'job-new' }));
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
const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');

const T = { timeout: 120_000 };
let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  submitJobMock.mockClear();
});
afterEach(() => vi.restoreAllMocks());
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

async function failedSession() {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  const s = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([card.identifier]),
    'Split it',
  );
  await adminDb.planChangeSession.update({
    where: { id: s.id },
    data: {
      lastJobId: 'job-1',
      failedAt: new Date(),
      failedJobId: 'job-1',
      failureReason: 'rate_limited',
    },
  });
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: s.id,
      status: 'generating',
      sourceJobId: 'job-1',
      createdById: fx.ownerId,
    },
  });
  return { sessionId: s.id, planId: plan.id };
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

async function expectRefused(
  f: { sessionId: string; planId: string },
  error: new (...a: never[]) => Error,
) {
  await expect(planSessionResumeService.resume(me(), f.sessionId)).rejects.toBeInstanceOf(error);
  // Nothing was written: the plan still names the failed job, the failure is still on record.
  expect((await planRow(f.planId)).sourceJobId).toBe('job-1');
  expect((await sessionRow(f.sessionId)).failedJobId).toBe('job-1');
}

describe('the bind refuses a state that moved between the pre-check and the locks', () => {
  it('the plan row is gone under the lock', T, async () => {
    const f = await failedSession();
    vi.spyOn(planRepository, 'lockById').mockResolvedValueOnce(false as never);
    await expectRefused(f, PlanNotResumableError);
  });

  it('the session row is gone under the lock', T, async () => {
    const f = await failedSession();
    vi.spyOn(planChangeSessionRepository, 'lockById').mockResolvedValueOnce(false as never);
    await expectRefused(f, PlanSessionNotFoundError);
  });

  it('the session cannot be re-read', T, async () => {
    const f = await failedSession();
    vi.spyOn(planChangeSessionRepository, 'findById').mockResolvedValueOnce(null);
    await expectRefused(f, PlanSessionNotFoundError);
  });

  it('a person ended it first', T, async () => {
    const f = await failedSession();
    const real = planChangeSessionRepository.findById.bind(planChangeSessionRepository);
    vi.spyOn(planChangeSessionRepository, 'findById').mockImplementationOnce(async (...a) => {
      const row = await real(...a);
      return row ? { ...row, endedAt: new Date() } : row;
    });
    await expectRefused(f, PlanSessionEndedError);
  });

  it('a concurrent Resume already cleared the failure — it names the winner’s job', T, async () => {
    const f = await failedSession();
    const real = planChangeSessionRepository.findById.bind(planChangeSessionRepository);
    vi.spyOn(planChangeSessionRepository, 'findById').mockImplementationOnce(async (...a) => {
      const row = await real(...a);
      return row ? { ...row, failedAt: null, failedJobId: null, lastJobId: 'job-winner' } : row;
    });
    const err = await planSessionResumeService.resume(me(), f.sessionId).catch((e) => e);
    expect(err).toBeInstanceOf(ResumeAlreadyStartedError);
    expect((err as ResumeAlreadyStartedError).jobId).toBe('job-winner');
  });

  it('a newer failure replaced the one being resumed', T, async () => {
    const f = await failedSession();
    const real = planChangeSessionRepository.findById.bind(planChangeSessionRepository);
    vi.spyOn(planChangeSessionRepository, 'findById').mockImplementationOnce(async (...a) => {
      const row = await real(...a);
      return row ? { ...row, failedJobId: 'job-other' } : row;
    });
    await expectRefused(f, PlanNotResumableError);
  });

  it('the plan stopped being the failed walk', T, async () => {
    const f = await failedSession();
    const real = planRepository.findById.bind(planRepository);
    vi.spyOn(planRepository, 'findById').mockImplementationOnce(async (...a) => {
      const row = await real(...a);
      return row ? { ...row, status: 'planned' } : row;
    });
    await expectRefused(f, PlanNotResumableError);
  });

  it('the re-point lost to another writer', T, async () => {
    const f = await failedSession();
    vi.spyOn(planRepository, 'repointSourceJob').mockResolvedValueOnce(false as never);
    await expectRefused(f, PlanNotResumableError);
  });

  it('the attempt cannot be recorded because the session just ended', T, async () => {
    const f = await failedSession();
    vi.spyOn(planChangeSessionRepository, 'recordResumedAttempt').mockResolvedValueOnce(false);
    await expectRefused(f, PlanSessionEndedError);
  });
});
