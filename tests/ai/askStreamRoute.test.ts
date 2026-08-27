import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';

// Route-level TRANSPORT tests for the ask stream (Story MOTIR-1343 · MOTIR-1819)
// — `GET /api/ai/ask/:jobId/stream`.
//
// The seam it proves is deliberately narrow, and the companion route suite
// (`askRoutes.test.ts`) covers everything else: this file asserts that the ask
// stream IS the shipped streaming path rather than a second one. Same
// `streamJob` relay, same SSE framing, same first-frame PRIMING so a pre-stream
// failure maps to a real HTTP status, same gate-before-open ordering, and the
// same client-disconnect release. A bespoke SSE implementation would pass none
// of these unchanged.
//
// Mocked: the boundary client, the two context resolvers the test env cannot
// supply with no cookies, and the permission gate — `activeCtx` is a synthetic
// project with no rows behind it, so the real gate would 404 and these cases
// would stop testing the relay they exist for (the `api-ai-chat-route` precedent;
// the gate itself is covered against real Postgres elsewhere).

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

// MOTIR-3653 / MOTIR-3648 — every route and route group now resolves the 2FA
// hold first. This suite is about this route's own gates, so the policy answers
// "nobody is asking", which is the state each case below was written in.
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const streamJobMock = vi.fn<(jobId: string) => AsyncGenerator<JobStreamEvent>>();
const getJobMock = vi.fn();
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn() },
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  streamJob: (jobId: string) => streamJobMock(jobId),
  submitJob: vi.fn(),
  getJob: (jobId: string) => getJobMock(jobId),
}));

const { GET } = await import('@/app/api/ai/ask/[jobId]/stream/route');
const { PermissionDeniedError } = await import('@/lib/projects/errors');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { MotirAiJobNotFoundError, MotirAiUnavailableError } = await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

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
  return { generator: iterator as unknown as AsyncGenerator<JobStreamEvent>, nextSpy, returnSpy };
}

function sse(frames: JobStreamEvent[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

function streamReq(jobId: string) {
  return GET(new Request(`${BASE}/api/ai/ask/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
}

beforeEach(() => {
  streamJobMock.mockReset();
  getJobMock.mockReset();
  getJobMock.mockResolvedValue({ status: 'succeeded' });
  vi.mocked(projectAccessService.assertPermission).mockReset();
  vi.mocked(projectAccessService.assertPermission).mockResolvedValue(undefined as never);
  session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
  activeCtx.current = {
    userId: 'user_1',
    workspaceId: 'w1',
    projectId: 'p1',
    project: { id: 'p1', identifier: 'ABC' } as ProjectContext['project'],
  };
});

describe('the gates run BEFORE the stream opens', () => {
  it('401s with no session', async () => {
    session.current = null;
    expect((await streamReq('job-1')).status).toBe(401);
  });

  it('404s with no active project', async () => {
    activeCtx.current = null;
    expect((await streamReq('job-1')).status).toBe(404);
  });

  it('refuses `ai:plan` with a real status — no SSE frame is ever written', async () => {
    vi.mocked(projectAccessService.assertPermission).mockRejectedValue(
      new PermissionDeniedError('p1', 'ai:plan'),
    );
    const res = await streamReq('job-1');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
  });
});

describe('the relay', () => {
  it('frames the job stream as SSE, in order, and closes', async () => {
    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'retrieval', data: { tool: 'get_item', family: 'plan_tree' } },
      { event: 'status', data: { status: 'succeeded' } },
    ];
    const { generator } = scriptedStream(frames.map((value) => ({ type: 'yield', value })));
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await expect(res.text()).resolves.toBe(sse(frames));
  });

  it('PRIMES the first frame — an unknown job is a 404, not a stream that errors', async () => {
    const { generator } = scriptedStream([
      { type: 'throw', error: new MotirAiJobNotFoundError('job-1') },
    ]);
    streamJobMock.mockReturnValue(generator);
    expect((await streamReq('job-1')).status).toBe(404);
  });

  it('PRIMES the first frame — an unreachable motir-ai is a 502', async () => {
    const { generator } = scriptedStream([
      { type: 'throw', error: new MotirAiUnavailableError('down') },
    ]);
    streamJobMock.mockReturnValue(generator);
    expect((await streamReq('job-1')).status).toBe(502);
  });

  it('releases the upstream iterator when the client disconnects', async () => {
    const { generator, returnSpy } = scriptedStream([
      { type: 'yield', value: { event: 'status', data: { status: 'running' } } },
      { type: 'hang' },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job-1');
    await res.body!.cancel();
    expect(returnSpy).toHaveBeenCalled();
  });

  it('appends the terminal failure REASON so the rail learns WHY, not just THAT', async () => {
    const { generator } = scriptedStream([
      { type: 'yield', value: { event: 'status', data: { status: 'failed' } } },
    ]);
    streamJobMock.mockReturnValue(generator);
    getJobMock.mockResolvedValue({
      status: 'failed',
      error: { code: 'MOTIR_AI_OUT_OF_CREDITS', message: 'no credits' },
    });

    const text = await (await streamReq('job-1')).text();
    expect(text).toContain('event: error');
    expect(text).toContain('MOTIR_AI_OUT_OF_CREDITS');
  });

  // ── A failure AFTER the headers are sent (MOTIR-1822) ─────────────────────
  //
  // The two halves of the relay fail differently, and only one of them can
  // still choose a status code. Once frames are flowing the response is
  // committed, so the ONLY way to tell the rail why it stopped is a terminal
  // `error` frame — and a stream that simply ends carries no reason at all,
  // which is what a reader would then have to guess at.

  it('a MID-STREAM failure closes with a typed terminal error frame', async () => {
    const { generator } = scriptedStream([
      { type: 'yield', value: { event: 'status', data: { status: 'running' } } },
      { type: 'throw', error: new MotirAiUnavailableError('upstream went away') },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job-1');
    // The status was already 200 — headers went out with the first frame.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: status');
    expect(text).toContain('event: error');
    expect(text).toContain('upstream went away');
  });

  it('a mid-stream failure OUTSIDE the taxonomy still names itself', async () => {
    // An unrecognised throw must not close the stream silently: the rail would
    // read a clean end as "the job finished" and file nothing.
    const { generator } = scriptedStream([
      { type: 'yield', value: { event: 'status', data: { status: 'running' } } },
      { type: 'throw', error: new Error('kaboom') },
    ]);
    streamJobMock.mockReturnValue(generator);

    const text = await (await streamReq('job-1')).text();
    expect(text).toContain('event: error');
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).toContain('kaboom');
  });

  it('a non-Error thrown mid-stream still closes with a frame the rail can read', async () => {
    // A `throw 'string'` from a transport library is not hypothetical, and the
    // frame has to carry SOMETHING — a terminal error with an empty message
    // reads to the rail as a stream that ended for no reason.
    const { generator } = scriptedStream([
      { type: 'yield', value: { event: 'status', data: { status: 'running' } } },
      { type: 'throw', error: 'not an Error at all' as unknown as Error },
    ]);
    streamJobMock.mockReturnValue(generator);

    const text = await (await streamReq('job-1')).text();
    expect(text).toContain('event: error');
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).toContain('stream failed');
  });

  it('a PRE-stream failure outside the taxonomy is RETHROWN, not flattened', async () => {
    // Before the first frame the route can still answer with a status, so an
    // error it does not recognise must surface as a fault rather than as a
    // plausible 502 that blames motir-ai for something else.
    const { generator } = scriptedStream([{ type: 'throw', error: new Error('kaboom') }]);
    streamJobMock.mockReturnValue(generator);

    await expect(streamReq('job-1')).rejects.toThrow('kaboom');
  });

  it('a GATE failure outside the AI-gate taxonomy is RETHROWN too', async () => {
    vi.mocked(projectAccessService.assertPermission).mockRejectedValue(new Error('kaboom'));

    await expect(streamReq('job-1')).rejects.toThrow('kaboom');
  });
});
