import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';
import { makeWorkItemFixture } from './fixtures/workItemFixtures';
import { truncateAuthTables } from './helpers/db';

// Route-level transport tests for the AI sprint-planning API (Subtask 7.13.5 ·
// MOTIR-918):
//   - POST /api/ai/plan/sprint                 — submit a plan_sprint job,
//   - GET  /api/ai/plan/sprint/:jobId/stream   — relay the job SSE to the browser,
//   - POST /api/ai/plan/sprint/approve         — persist an approved packing.
//
// The COMPANION integration test (`tests/integration/ai/aiSprintPlanning.test.ts`)
// proves the persist end-to-end against a real Postgres. This file proves what
// the ROUTES own: the session + active-project gates on all three, the
// disabled-opt-in refusal as a distinct status, out-of-credits as a 402, the
// generic-failure 502, body validation, the re-validation failures mapping to
// 400, and the SSE wire framing/priming.
//
// Per the motir-core convention we mock ONLY the boundary client + the two
// context resolvers the test env cannot supply with no cookies (getSession,
// getActiveProject) — the same exception the sibling route suites take.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const streamJobMock = vi.fn<(jobId: string) => AsyncGenerator<JobStreamEvent>>();
const submitJobMock = vi.fn();
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  streamJob: (jobId: string) => streamJobMock(jobId),
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (jobId: string) => getJobMock(jobId),
}));
// …and the project gate (MOTIR-2358). These cases drive a SYNTHETIC ProjectContext
// with no rows behind it, so the real assert would 404 on the project id and
// prove nothing about the boundary contract they are here for. The gate is
// covered against real Postgres in `tests/integration/ai/planPermissionGate.test.ts`.
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn() },
}));

const { POST: SUBMIT } = await import('@/app/api/ai/plan/sprint/route');
const { GET: STREAM } = await import('@/app/api/ai/plan/sprint/[jobId]/stream/route');
const { POST: APPROVE } = await import('@/app/api/ai/plan/sprint/approve/route');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError, MotirAiJobNotFoundError } =
  await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

function scriptedStream(
  steps: Array<{ type: 'yield'; value: JobStreamEvent } | { type: 'throw'; error: Error }>,
) {
  let i = 0;
  const returnSpy = vi.fn(
    async (): Promise<IteratorResult<JobStreamEvent>> => ({ done: true, value: undefined }),
  );
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<JobStreamEvent>> => {
      const step = steps[i++];
      if (!step) return { done: true, value: undefined };
      if (step.type === 'throw') throw step.error;
      return { done: false, value: step.value };
    }),
    return: returnSpy,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { generator: iterator as unknown as AsyncGenerator<JobStreamEvent>, returnSpy };
}

function submitReq() {
  return SUBMIT();
}

function streamReq(jobId: string) {
  return STREAM(new Request(`${BASE}/api/ai/plan/sprint/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
}

function approveReq(body: unknown, opts: { raw?: string } = {}) {
  return APPROVE(
    new Request(`${BASE}/api/ai/plan/sprint/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
    }),
  );
}

async function seedActiveProject(opts: { sprintPlanning?: boolean } = {}) {
  await truncateAuthTables();
  const fx = await makeWorkItemFixture();
  if (opts.sprintPlanning !== false) {
    await db.project.update({
      where: { id: fx.projectId },
      data: { aiSprintPlanningEnabled: true, aiSprintLengthDays: 2 },
    });
  }
  session.current = { user: { id: fx.ownerId, email: 'pm@moooon.net', name: 'PM' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  return fx;
}

beforeEach(() => {
  session.current = null;
  activeCtx.current = null;
  streamJobMock.mockReset();
  submitJobMock.mockReset();
  getJobMock.mockReset();
});
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/ai/plan/sprint', () => {
  it('401s an unauthenticated request before touching the service', async () => {
    const res = await submitReq();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (no-existence-leak, #26)', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    const res = await submitReq();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project.',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('submits and returns { jobId }, uncached', async () => {
    await seedActiveProject();
    submitJobMock.mockResolvedValue({ jobId: 'job_sprint_1' });

    const res = await submitReq();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(res.json()).resolves.toEqual({ jobId: 'job_sprint_1' });
  });

  it('409s when the project has not opted into AI sprint planning', async () => {
    await seedActiveProject({ sprintPlanning: false });

    const res = await submitReq();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'SPRINT_PLANNING_DISABLED' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('maps out-of-credits to a DISTINCT 402, and a generic boundary failure to 502', async () => {
    await seedActiveProject();

    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('no credits'));
    expect((await submitReq()).status).toBe(402);

    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    expect((await submitReq()).status).toBe(502);
  });
});

describe('GET /api/ai/plan/sprint/:jobId/stream', () => {
  it('401s / 404s on the same two gates, before opening a stream', async () => {
    expect((await streamReq('job_1')).status).toBe(401);
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    expect((await streamReq('job_1')).status).toBe(404);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('relays the job frames as SSE with the streaming headers', async () => {
    await seedActiveProject();
    const { generator } = scriptedStream([
      { type: 'yield', value: { event: 'progress', data: { phase: 'read' } } },
      { type: 'yield', value: { event: 'progress', data: { phase: 'packed' } } },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_sprint_1');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('event: progress');
    expect(body).toContain('"phase":"read"');
    expect(body).toContain('"phase":"packed"');
  });

  it('surfaces a FIRST-frame failure as a real HTTP status, not a 200 that errors', async () => {
    await seedActiveProject();

    const { generator: notFound } = scriptedStream([
      { type: 'throw', error: new MotirAiJobNotFoundError('nope') },
    ]);
    streamJobMock.mockReturnValueOnce(notFound);
    expect((await streamReq('job_missing')).status).toBe(404);

    const { generator: down } = scriptedStream([
      { type: 'throw', error: new MotirAiUnavailableError('down') },
    ]);
    streamJobMock.mockReturnValueOnce(down);
    expect((await streamReq('job_sprint_1')).status).toBe(502);
  });
});

describe('POST /api/ai/plan/sprint/approve', () => {
  const emptyDelta = {
    deltaVersion: 'v1',
    sprintLengthDays: 2,
    capacityMinutes: 720,
    agentMinutesPerDay: 360,
    itemCount: 0,
    totalEstimateMinutes: 0,
    unestimatedKeys: [],
    oversizedKeys: [],
    sprints: [],
  };

  it('401s / 404s on the same two gates', async () => {
    expect((await approveReq({ jobId: 'job_1' })).status).toBe(401);
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    expect((await approveReq({ jobId: 'job_1' })).status).toBe(404);
  });

  it('400s a malformed JSON body and a missing jobId', async () => {
    await seedActiveProject();
    expect((await approveReq(undefined, { raw: '{' })).status).toBe(400);
    const res = await approveReq({});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('commits an empty packing as a no-op 200', async () => {
    await seedActiveProject();

    const res = await approveReq({ jobId: 'job_sprint_1', approvedDelta: emptyDelta });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(res.json()).resolves.toEqual({ sprints: [], assigned: 0 });
  });

  it('400s a packing that fails the SHAPE gate, with its own code', async () => {
    await seedActiveProject();

    const res = await approveReq({
      jobId: 'job_sprint_1',
      approvedDelta: { ...emptyDelta, deltaVersion: 'v9' },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'SPRINT_ASSIGNMENT_INVALID' });
  });

  it('400s a well-formed but ILLEGAL packing, with the distinct semantic code', async () => {
    await seedActiveProject();

    const res = await approveReq({
      jobId: 'job_sprint_1',
      approvedDelta: {
        ...emptyDelta,
        sprints: [
          {
            tempId: 'sprint:1',
            name: 'S',
            lengthDays: 2,
            itemKeys: ['PROD-999'],
            totalEstimateMinutes: 0,
            capacityMinutes: 720,
            oversizedKeys: [],
            rationale: '',
          },
        ],
      },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'SPRINT_PLAN_APPROVE_ERROR' });
  });

  it('502s when the job read-back fails at the boundary', async () => {
    await seedActiveProject();
    getJobMock.mockRejectedValue(new MotirAiUnavailableError('down'));

    const res = await approveReq({ jobId: 'job_sprint_1' });

    expect(res.status).toBe(502);
  });
});
