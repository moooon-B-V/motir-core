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
});
