import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';
import { makeWorkItemFixture } from './fixtures/workItemFixtures';
import { truncateAuthTables } from './helpers/db';

// Route-level transport tests for the chat proxy (Subtask 7.3.7b) — the two
// handlers 7.3.4 (MOTIR-832) shipped:
//   - GET  /api/ai/chat/:jobId/stream — relays the motir-ai discovery job as SSE,
//   - POST /api/ai/chat               — submits a user turn, mapping typed errors.
//
// The COMPANION service test (`tests/ai/aiChatService.test.ts`) proves the
// service relays the client generator + builds the submit tenant. This file
// proves the things only the ROUTE owns and that the service test does NOT
// exercise:
//   - the SSE wire framing (`event: <e>\ndata: <json>\n\n` per frame, in order,
//     terminal close) the route's own `formatFrame` builds — the service yields
//     typed objects, never bytes;
//   - first-frame PRIMING: a pre-stream upstream failure surfaces as a real HTTP
//     status (404 unknown job / 502 otherwise), NOT a stream that opens then
//     emits an SSE error frame;
//   - client disconnect (`cancel`) releases the upstream iterator
//     (`iterator.return` is called) so the motir-ai connection never leaks;
//   - POST's session-gate 401, active-project-gate 404 (no-existence-leak shape,
//     finding #26), body-validation 400, and `MotirAiError -> 502` mapping.
//
// Per the motir-core convention we mock ONLY the boundary client
// (`@/lib/ai/motirAiClient`) + the two context resolvers the test env can't
// supply with no cookies (`getSession`, `getActiveProject`) — the same exception
// `api-ai-preplan-route.test.ts` takes. Everything else runs for real: the POST
// 502 path resolves the workspace org against a REAL seeded workspace through the
// real `aiChatService` -> `withWorkspaceContext` -> `workspaceRepository` chain,
// so only the network leaf is faked.

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

// Import the handlers AFTER the mocks are registered.
const { GET } = await import('@/app/api/ai/chat/[jobId]/stream/route');
const { POST } = await import('@/app/api/ai/chat/route');
const { MotirAiJobNotFoundError, MotirAiUnavailableError, MotirAiOutOfCreditsError } =
  await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

// ── A scriptable async iterator standing in for the motir-ai job stream ───────
// The route drives `streamJob(jobId)[Symbol.asyncIterator]()` directly — priming
// `.next()`, looping it, and calling `.return()` on close/cancel/error. A native
// generator can't expose a spy on `.return`, so we hand-roll an iterable whose
// `next`/`return` ARE the spies. Each step says what the next pull does: yield a
// frame, throw, or hang (never resolve — to park the route mid-stream so a
// `cancel()` can be observed).
type StreamStep =
  | { type: 'yield'; value: JobStreamEvent }
  | { type: 'throw'; error: Error }
  | { type: 'hang' };

function scriptedStream(steps: StreamStep[]) {
  let i = 0;
  const returnSpy = vi.fn(
    async (): Promise<IteratorResult<JobStreamEvent>> => ({ done: true, value: undefined }),
  );
  const nextSpy = vi.fn(async (): Promise<IteratorResult<JobStreamEvent>> => {
    const step = steps[i++];
    if (!step) return { done: true, value: undefined };
    if (step.type === 'throw') throw step.error;
    if (step.type === 'hang') return new Promise<IteratorResult<JobStreamEvent>>(() => {});
    return { done: false, value: step.value };
  });
  const iterator = {
    next: nextSpy,
    return: returnSpy,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  // The route only ever calls `streamJob(jobId)[Symbol.asyncIterator]()`, so the
  // returned object IS the iterator. Cast through the generator type the client
  // declares — the route consumes only the AsyncIterator surface.
  return {
    generator: iterator as unknown as AsyncGenerator<JobStreamEvent>,
    nextSpy,
    returnSpy,
  };
}

/** Build the expected SSE wire text for a sequence of frames. */
function sse(frames: JobStreamEvent[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

function streamReq(jobId: string) {
  return GET(new Request(`${BASE}/api/ai/chat/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
}

function postReq(body: unknown, opts: { raw?: string } = {}) {
  return POST(
    new Request(`${BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
    }),
  );
}

function signIn() {
  session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
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

describe('GET /api/ai/chat/:jobId/stream', () => {
  it('401s an unauthenticated request before opening the stream', async () => {
    const res = await streamReq('job_1');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (the no-existence-leak shape)', async () => {
    signIn();
    const res = await streamReq('job_1');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project.',
    });
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('relays the job frames as well-formed SSE, in order, then closes the iterator', async () => {
    signIn();
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const frames: JobStreamEvent[] = [
      { event: 'assistant', data: { token: 'Let’s plan ' } },
      { event: 'state', data: { gate: 'vision' } },
      { event: 'status', data: { status: 'running' } },
      { event: 'docs', data: [{ kind: 'discovery', version: 1 }] },
    ];
    const { generator, returnSpy } = scriptedStream(
      frames.map((value) => ({ type: 'yield', value })),
    );
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_42');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(streamJobMock).toHaveBeenCalledWith('job_42');

    const body = await res.text();
    expect(body).toBe(sse(frames));
    // Terminal close releases the upstream reader exactly once.
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('appends the failure REASON as an SSE error frame after a terminal `failed` status (8.1.8)', async () => {
    signIn();
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'status', data: { status: 'failed' } },
    ];
    const { generator } = scriptedStream(frames.map((value) => ({ type: 'yield', value })));
    streamJobMock.mockReturnValue(generator);
    // The reason lives only on GET /v1/jobs/:id (JobView.error), not the stream.
    getJobMock.mockResolvedValue({
      jobId: 'job_oc',
      status: 'failed',
      result: null,
      error: new MotirAiOutOfCreditsError('out of credits'),
    });

    const res = await streamReq('job_oc');
    const body = await res.text();

    // The error frame is inserted right after the failed status (before close), so
    // the client learns it's out-of-credits → renders the paywall.
    const expectedError: JobStreamEvent = {
      event: 'error',
      data: {
        code: 'MOTIR_AI_OUT_OF_CREDITS',
        message: 'motir-ai refused the job — out of credits: out of credits',
      },
    };
    expect(body).toBe(sse([...frames, expectedError]));
    expect(getJobMock).toHaveBeenCalledWith('job_oc');
  });

  it('priming surfaces an unknown job (MotirAiJobNotFoundError) as a real 404, not an SSE error frame', async () => {
    signIn();
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
    // A real JSON HTTP response, NOT a stream that opens then errors.
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json();
    expect(body.code).toBe('MOTIR_AI_JOB_NOT_FOUND');
    // The primed-then-failed iterator is released.
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('priming maps a generic upstream failure to a real 502', async () => {
    signIn();
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const { generator, returnSpy } = scriptedStream([
      { type: 'throw', error: new MotirAiUnavailableError('connect ECONNREFUSED') },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_dead');

    expect(res.status).toBe(502);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_UNAVAILABLE' });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the upstream iterator when the client disconnects mid-stream (cancel)', async () => {
    signIn();
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    // One frame primes + enqueues, then the next pull hangs — parking the route
    // inside the stream so a disconnect is the only thing that can end it.
    const frame: JobStreamEvent = { event: 'assistant', data: { token: 'hi' } };
    const { generator, returnSpy } = scriptedStream([
      { type: 'yield', value: frame },
      { type: 'hang' },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_live');
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe(sse([frame]));

    // The browser closes EventSource → the ReadableStream is cancelled.
    await reader.cancel();
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ai/chat', () => {
  it('401s an unauthenticated request before touching the service / motir-ai', async () => {
    const res = await postReq({ prompt: 'build me a tracker' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (the no-existence-leak shape)', async () => {
    signIn();
    const res = await postReq({ prompt: 'build me a tracker' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project.',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('400s a malformed JSON body (after the gates, before the service)', async () => {
    signIn();
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;
    const res = await postReq(undefined, { raw: '{ not json' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('400s an empty/whitespace prompt', async () => {
    signIn();
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;
    const res = await postReq({ prompt: '   ' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      code: 'BAD_REQUEST',
      error: '`prompt` is required.',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('maps a motir-ai failure to 502 after resolving the org against the real workspace', async () => {
    // Real seeded tenant: the route -> aiChatService -> withWorkspaceContext ->
    // workspaceRepository chain resolves the org against Postgres for real; only
    // the network leaf (submitJob) is faked, and it fails.
    await truncateAuthTables();
    const fx = await makeWorkItemFixture();
    signIn();
    session.current = { user: { id: fx.ownerId, email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };

    submitJobMock.mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const res = await postReq({ prompt: 'build me a tracker' });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('MOTIR_AI_UNAVAILABLE');
    // The org WAS resolved off the real workspace before the failing submit.
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [jobKind, tenant] = submitJobMock.mock.calls[0]!;
    expect(jobKind).toBe('discovery');
    expect(tenant).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
    expect((tenant as { organizationId: string }).organizationId).toEqual(expect.any(String));
  });

  it('returns the jobId with a private no-store header on a successful submit', async () => {
    await truncateAuthTables();
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };

    submitJobMock.mockResolvedValue({ jobId: 'job_live_1' });

    const res = await postReq({ prompt: 'build me a tracker' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(res.json()).resolves.toEqual({ jobId: 'job_live_1' });
  });
});
