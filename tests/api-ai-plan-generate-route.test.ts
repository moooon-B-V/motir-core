import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';
import { planRepository } from '@/lib/repositories/planRepository';
import { makeWorkItemFixture } from './fixtures/workItemFixtures';
import { truncateAuthTables } from './helpers/db';

// Route-level transport tests for the generation API (Subtask 7.4.4 · MOTIR-846):
//   - POST /api/ai/plan/generate              — opens a Plan + submits generate_tree,
//   - GET  /api/ai/plan/generate/:jobId/stream — relays the job SSE to the browser.
//
// The COMPANION integration test (`tests/integration/ai/generationProposals.test.ts`)
// proves the internal append seam end-to-end. This file proves what the ROUTES own:
// the session/active-project gates, the {jobId, planId} success shape + the opened
// `generating` Plan (read back from a REAL Postgres), out-of-credits as a DISTINCT
// 402 (7.2 metering), the generic-failure 502, and the SSE wire framing/priming.
//
// Per the motir-core convention we mock ONLY the boundary client + the two context
// resolvers the test env can't supply with no cookies (getSession, getActiveProject)
// — the same exception api-ai-chat-route.test.ts takes. Everything else runs for
// real: createPlan persists to Postgres, resolveTenantOrg reads the seeded org.

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

const { GET } = await import('@/app/api/ai/plan/generate/[jobId]/stream/route');
const { POST } = await import('@/app/api/ai/plan/generate/route');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError, MotirAiJobNotFoundError } =
  await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

function sse(frames: JobStreamEvent[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

function scriptedStream(
  steps: Array<{ type: 'yield'; value: JobStreamEvent } | { type: 'throw'; error: Error }>,
) {
  let i = 0;
  const returnSpy = vi.fn(
    async (): Promise<IteratorResult<JobStreamEvent>> => ({ done: true, value: undefined }),
  );
  const nextSpy = vi.fn(async (): Promise<IteratorResult<JobStreamEvent>> => {
    const step = steps[i++];
    if (!step) return { done: true, value: undefined };
    if (step.type === 'throw') throw step.error;
    return { done: false, value: step.value };
  });
  const iterator = {
    next: nextSpy,
    return: returnSpy,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { generator: iterator as unknown as AsyncGenerator<JobStreamEvent>, returnSpy };
}

function postReq(body: unknown, opts: { raw?: string } = {}) {
  return POST(
    new Request(`${BASE}/api/ai/plan/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
    }),
  );
}

function streamReq(jobId: string) {
  return GET(new Request(`${BASE}/api/ai/plan/generate/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
}

async function seedActiveProject() {
  await truncateAuthTables();
  const fx = await makeWorkItemFixture();
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

describe('POST /api/ai/plan/generate', () => {
  it('401s an unauthenticated request before touching the service', async () => {
    const res = await postReq({});
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (no-existence-leak, #26)', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    const res = await postReq({});
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project.',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('opens a generating Plan bound to the job and returns { jobId, planId }', async () => {
    const fx = await seedActiveProject();
    submitJobMock.mockResolvedValue({ jobId: 'job_gen_1' });

    const res = await postReq({ prompt: 'build me a tracker' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.jobId).toBe('job_gen_1');
    expect(typeof body.planId).toBe('string');

    // generate_tree job submitted with the resolved tenant + prompt + actor.
    const [jobKind, tenant, context, actor] = submitJobMock.mock.calls[0]!;
    expect(jobKind).toBe('generate_tree');
    expect(tenant).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
    // The envelope carries the prompt + the project's AI-explanations opt-in
    // (Story 7.4 · MOTIR-850) — OFF by default for a fresh project.
    expect(context).toEqual({ prompt: 'build me a tracker', generateExplanations: false });
    expect(actor).toEqual({ userId: fx.ownerId });

    // The Plan really exists, is `generating`, and is bound to the job (sourceJobId).
    const plan = await planRepository.findById(body.planId, fx.workspaceId);
    expect(plan).not.toBeNull();
    expect(plan!.status).toBe('generating');
    expect(plan!.sourceJobId).toBe('job_gen_1');
    expect(plan!.projectId).toBe(fx.projectId);
  });

  it('threads the project aiGenerateExplanations opt-in into the generate_tree envelope (MOTIR-850)', async () => {
    const fx = await seedActiveProject();
    // Opt the active project INTO AI-drafted explanations — the flag rides the
    // envelope context so motir-ai's generate_tree handler drafts explanations.
    activeCtx.current!.project = { ...fx.project, aiGenerateExplanations: true };
    submitJobMock.mockResolvedValue({ jobId: 'job_gen_expl' });

    const res = await postReq({ prompt: 'with explanations' });
    expect(res.status).toBe(200);

    const [jobKind, , context] = submitJobMock.mock.calls[0]!;
    expect(jobKind).toBe('generate_tree');
    expect(context).toEqual({ prompt: 'with explanations', generateExplanations: true });
  });

  it('surfaces out-of-credits as a DISTINCT 402, leaving NO orphan Plan', async () => {
    const fx = await seedActiveProject();
    submitJobMock.mockRejectedValue(new MotirAiOutOfCreditsError('balance 0'));

    const res = await postReq({});

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_OUT_OF_CREDITS' });
    // Submit-first means a refused submit never opened a Plan.
    const count = await db.plan.count({ where: { projectId: fx.projectId } });
    expect(count).toBe(0);
  });

  it('maps a generic motir-ai failure to 502', async () => {
    await seedActiveProject();
    submitJobMock.mockRejectedValue(new MotirAiUnavailableError('ECONNREFUSED'));

    const res = await postReq({});
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_UNAVAILABLE' });
  });
});

describe('GET /api/ai/plan/generate/:jobId/stream', () => {
  it('401s an unauthenticated request before opening the stream', async () => {
    const res = await streamReq('job_1');
    expect(res.status).toBe(401);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    const res = await streamReq('job_1');
    expect(res.status).toBe(404);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('relays live PlanItem frames as well-formed SSE, then closes', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'planItem', data: { op: 'add', title: 'Epic: Auth' } },
      { event: 'status', data: { status: 'succeeded' } },
    ];
    const { generator, returnSpy } = scriptedStream(
      frames.map((value) => ({ type: 'yield' as const, value })),
    );
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_42');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(streamJobMock).toHaveBeenCalledWith('job_42');
    expect(await res.text()).toBe(sse(frames));
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('appends the out-of-credits REASON as an SSE error frame after a terminal `failed` status', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'status', data: { status: 'failed' } },
    ];
    const { generator } = scriptedStream(
      frames.map((value) => ({ type: 'yield' as const, value })),
    );
    streamJobMock.mockReturnValue(generator);
    getJobMock.mockResolvedValue({
      jobId: 'job_oc',
      status: 'failed',
      result: null,
      error: new MotirAiOutOfCreditsError('out of credits'),
    });

    const res = await streamReq('job_oc');
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).toContain('MOTIR_AI_OUT_OF_CREDITS');
  });

  it('priming surfaces an unknown job as a real 404, not an SSE error frame', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const { generator, returnSpy } = scriptedStream([
      { type: 'throw', error: new MotirAiJobNotFoundError('job_unknown') },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_JOB_NOT_FOUND' });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});
