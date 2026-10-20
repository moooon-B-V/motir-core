import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { PlanNotResumableError } from '@/lib/planChange/errors';
import { MotirAiBadRequestError } from '@/lib/ai/errors';
import { homeService } from '@/lib/services/homeService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-9121 — A FAILED ATTEMPT MOTIR-AI CANNOT RESUME HOLDS NOTHING, against a REAL Postgres.
//
// Production: a planning job sat queued past its read token's life, failed reading its target
// before its conversation settled, and motir-ai refuses every Resume of such a job. Core still
// offered Resume, refused every new turn in favour of it, and kept the card at Planning with a
// lock no sweep would expire. Now:
//
//   * a failure motir-ai reports `resumable: false` is recorded as such, its `generating` plan
//     is declined `abandoned`, and every target goes back to the status it was parked from;
//   * the session stays OPEN — the overlay reads a plan-again failure, To resume does not list
//     it, Resume is refused, and the next turn plans again (and clears the record);
//   * a failure recorded BEFORE motir-ai said so (unknown) reaches the same state the first time
//     a Resume is refused for want of a settled conversation;
//   * a resumable failure is untouched — Resume offered, cards held.
//
// motir-ai is stubbed at its client boundary (`submitJob`) and at the settle's `readJob` seam;
// everything else is the shipped path.

let jobSeq = 0;
const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: (...args: unknown[]) => submitJobMock(...args),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');

const T = { timeout: 120_000 };

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

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const locksOf = (sessionId: string, planId: string) =>
  adminDb.planTargetLock.count({ where: { OR: [{ sessionId }, { planId }] } });

/** A card `in_progress`, a conversation anchored on it, and its first attempt submitted — the
 *  attempt holds the card exactly as a real one does. */
async function attempt() {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `Card ${Math.random()}` },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });
  const session = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([card.identifier]),
    'plan this story',
  );
  const first = await planChangeSessionsService.submit(me(), { sessionId: session.id });
  return { card, sessionId: session.id, planId: first.planId, jobId: first.jobId };
}

/** The relay's settle, with motir-ai's job read answering `resumable`. */
const settle = (jobId: string, resumable: boolean | null) =>
  planSessionEndService.settleFailedJob(
    jobId,
    me(),
    { status: 'failed' },
    {
      readJob: async () => ({
        error: {
          code: 'MOTIR_AI_BAD_REQUEST',
          message: 'none of the target work items could be read',
        },
        walkStop: null,
        resumable,
      }),
    },
  );

async function expectReleased(a: Awaited<ReturnType<typeof attempt>>) {
  const session = await sessionRow(a.sessionId);
  expect(session.endedAt).toBeNull();
  expect(session.failedAt).not.toBeNull();
  expect(session.failureResumable).toBe(false);
  const plan = await planRow(a.planId);
  expect(plan.status).toBe('declined');
  expect(plan.decisionReason).toBe('abandoned');
  expect(await locksOf(a.sessionId, a.planId)).toBe(0);
  // Back to the status it was parked from — out of Planning.
  expect(await statusOf(a.card.id)).toBe('in_progress');
}

describe('a failure motir-ai reports as NOT resumable (MOTIR-9121)', () => {
  it('⚠️ gives the attempt’s cards back and keeps the session open', T, async () => {
    const a = await attempt();
    expect(await locksOf(a.sessionId, a.planId)).toBeGreaterThan(0);

    const out = await settle(a.jobId, false);

    expect(out).toMatchObject({ settled: 'recorded', sessionId: a.sessionId, autoResume: null });
    await expectReleased(a);
  });

  it('reads as a plan-again failure: no Resume, and To resume does not list it', T, async () => {
    const a = await attempt();
    await settle(a.jobId, false);

    const dto = await planChangeSessionsService.getById(me(), a.sessionId);
    expect(dto.failure?.resumable).toBe(false);
    expect(dto.failedWaiting).toBe('reply');
    expect(dto.waitingPlan ?? null).toBeNull();

    const page = await homeService.listToResume({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect((page.planningSessions ?? []).map((s) => s.sessionId)).not.toContain(a.sessionId);
  });

  it('Resume is refused before any job is spent', T, async () => {
    const a = await attempt();
    await settle(a.jobId, false);
    submitJobMock.mockClear();

    await expect(planSessionResumeService.resume(me(), a.sessionId)).rejects.toBeInstanceOf(
      PlanNotResumableError,
    );
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('⚠️ the next turn plans again — a fresh job and plan — and clears the record', T, async () => {
    const a = await attempt();
    await settle(a.jobId, false);
    await planChangeSessionsService.appendTurn('plan this story', me(), { sessionId: a.sessionId });

    const next = await planChangeSessionsService.submit(me(), { sessionId: a.sessionId });

    expect(next.planId).not.toBe(a.planId);
    expect((await planRow(next.planId)).status).toBe('generating');
    const session = await sessionRow(a.sessionId);
    expect(session.failedAt).toBeNull();
    expect(session.failureResumable).toBeNull();
    expect(session.lastJobId).toBe(next.jobId);
  });
});

describe('a failure recorded before motir-ai said (unknown), refused on Resume (MOTIR-9121)', () => {
  it(
    '⚠️ the refusal leaves it released and not resumable, not offering the same Resume',
    T,
    async () => {
      const a = await attempt();
      await settle(a.jobId, null);
      // Recorded as before this change: resumable as far as core knows, cards still held.
      expect((await sessionRow(a.sessionId)).failureResumable).toBeNull();
      expect(await locksOf(a.sessionId, a.planId)).toBeGreaterThan(0);

      submitJobMock.mockRejectedValueOnce(
        new MotirAiBadRequestError(
          `resume.fromJobId ${a.jobId} carries no settled conversation to continue from`,
          400,
        ),
      );
      await expect(planSessionResumeService.resume(me(), a.sessionId)).rejects.toBeInstanceOf(
        PlanNotResumableError,
      );

      await expectReleased(a);
      const dto = await planChangeSessionsService.getById(me(), a.sessionId);
      expect(dto.failure?.resumable).toBe(false);
    },
  );

  it('any OTHER refusal of the resume changes nothing', T, async () => {
    const a = await attempt();
    await settle(a.jobId, null);
    submitJobMock.mockRejectedValueOnce(new MotirAiBadRequestError('something else', 400));

    await expect(planSessionResumeService.resume(me(), a.sessionId)).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );

    expect((await sessionRow(a.sessionId)).failureResumable).toBeNull();
    expect((await planRow(a.planId)).status).toBe('generating');
    expect(await locksOf(a.sessionId, a.planId)).toBeGreaterThan(0);
  });
});

describe('a RESUMABLE failure is unchanged', () => {
  it('keeps its plan and cards, offers Resume, and refuses a new turn for it', T, async () => {
    const a = await attempt();
    await settle(a.jobId, true);

    const session = await sessionRow(a.sessionId);
    expect(session.failureResumable).toBe(true);
    expect((await planRow(a.planId)).status).toBe('generating');
    expect(await locksOf(a.sessionId, a.planId)).toBeGreaterThan(0);
    const dto = await planChangeSessionsService.getById(me(), a.sessionId);
    expect(dto.failure?.resumable).toBe(true);
    expect(dto.failedWaiting).toBe('resume');
  });
});

describe('releaseUnresumableAttempt — the re-check under the locks (MOTIR-9121)', () => {
  it('an unknown session releases nothing', T, async () => {
    expect(
      await planSessionEndService.releaseUnresumableAttempt('no-such-session', fx.workspaceId),
    ).toEqual({ released: false });
  });

  it('a session that is not recorded as unresumable keeps its attempt', T, async () => {
    const a = await attempt();
    // Still running: no failure at all.
    expect(
      await planSessionEndService.releaseUnresumableAttempt(a.sessionId, fx.workspaceId),
    ).toEqual({ released: false });
    // Failed, but resumable.
    await settle(a.jobId, true);
    expect(
      await planSessionEndService.releaseUnresumableAttempt(a.sessionId, fx.workspaceId),
    ).toEqual({ released: false });
    expect((await planRow(a.planId)).status).toBe('generating');
    expect(await locksOf(a.sessionId, a.planId)).toBeGreaterThan(0);
  });

  it('a second release finds nothing held and changes nothing', T, async () => {
    const a = await attempt();
    await settle(a.jobId, false);
    expect(
      await planSessionEndService.releaseUnresumableAttempt(a.sessionId, fx.workspaceId),
    ).toEqual({ released: true });
    await expectReleased(a);
  });
});
