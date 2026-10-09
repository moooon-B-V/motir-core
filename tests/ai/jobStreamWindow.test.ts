import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';

// Bug MOTIR-7985 — a motir-ai job stream is a WINDOW, not the job.
//
// motir-ai holds `GET /v1/jobs/:id/stream` open for five minutes and then closes
// it with `done { timedOut: true }`, whatever the job's status. core relayed that
// `done` as the run's end, so the planning rail read a run still going as one
// that had settled with nothing ("Nothing came back to change") and never heard
// how it really ended.
//
// These cases drive the REAL relay — the augment stream route over the real
// `streamJob` — against a motir-ai whose responses are scripted at `fetch`: a
// first window that times out, then a second window that REPLAYS the job from
// seq 0 (motir-ai's contract §2.1) and carries it to a terminal status.
//
// Mocked: the two context resolvers the test env cannot supply with no cookies,
// the permission gate (`activeCtx` is a synthetic project with no rows behind
// it), and the session-end write a failed job triggers — each covered against
// real Postgres elsewhere. The motir-ai boundary is NOT mocked: `fetch` is.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn(async () => undefined) },
}));
const endSessionForFailedJob = vi.fn(async () => undefined);
vi.mock('@/lib/services/planSessionEndService', () => ({
  planSessionEndService: { endSessionForFailedJob },
}));

const { GET } = await import('@/app/api/ai/augment/[jobId]/stream/route');
const { followJobStream } = await import('@/lib/ai/motirAiClient');

const BASE = 'http://localhost:3000';

function sse(frames: JobStreamEvent[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

function sseResponse(frames: JobStreamEvent[]): Response {
  return new Response(sse(frames), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const status = (s: string): JobStreamEvent => ({
  event: 'status',
  data: { jobId: 'job-1', status: s },
});
const progress = (seq: number, event = 'retrieval'): JobStreamEvent => ({
  event,
  data: { jobId: 'job-1', seq, data: { n: seq } },
});
const windowClosed: JobStreamEvent = { event: 'done', data: { jobId: 'job-1', timedOut: true } };
const jobDone: JobStreamEvent = { event: 'done', data: { jobId: 'job-1' } };

/** A motir-ai that answers each stream subscription with the next window, and the
 *  job read with `job`. Returns the fetch spy. */
function motirAi(
  windows: JobStreamEvent[][],
  job: unknown = { jobId: 'job-1', status: 'running' },
) {
  let opened = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/stream?')) {
      const frames = windows[opened++];
      if (!frames) throw new Error(`unexpected stream subscription #${opened}`);
      return sseResponse(frames);
    }
    return jsonResponse(job);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const streamOpens = (fetchMock: ReturnType<typeof motirAi>) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes('/stream?')).length;

function streamReq(jobId: string) {
  return GET(new Request(`${BASE}/api/ai/augment/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  endSessionForFailedJob.mockClear();
  session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
  activeCtx.current = {
    userId: 'user_1',
    workspaceId: 'w1',
    projectId: 'p1',
    project: { id: 'p1', identifier: 'ABC' } as ProjectContext['project'],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the relay follows a job past the stream window', () => {
  it('re-subscribes on a timed-out done and relays every frame ONCE, up to the terminal done', async () => {
    const fetchMock = motirAi([
      [status('running'), progress(1), progress(2), windowClosed],
      // The second window replays from seq 0: the status it left off at, and
      // seq 1–2 again, before anything new.
      [status('running'), progress(1), progress(2), progress(3), status('succeeded'), jobDone],
    ]);

    const res = await streamReq('job-1');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(
      sse([status('running'), progress(1), progress(2), progress(3), status('succeeded'), jobDone]),
    );
    expect(streamOpens(fetchMock)).toBe(2);
  });

  it('a job that FAILS after the window reaches the browser as a failure, with its reason', async () => {
    const fetchMock = motirAi(
      [
        [status('running'), progress(1), windowClosed],
        [status('running'), progress(1), progress(2), windowClosed],
        [status('running'), progress(1), progress(2), status('failed'), jobDone],
      ],
      {
        jobId: 'job-1',
        status: 'failed',
        error: {
          type: 'about:blank',
          title: 'Upstream failed',
          status: 502,
          code: 'internal_error',
          detail: 'the planner model stopped answering',
        },
      },
    );

    const res = await streamReq('job-1');
    const body = await res.text();
    expect(streamOpens(fetchMock)).toBe(3);
    // Never a bare `done` before the failure: the timed-out windows are swallowed.
    expect(body.indexOf('timedOut')).toBe(-1);
    expect(body).toBe(
      sse([
        status('running'),
        progress(1),
        progress(2),
        status('failed'),
        {
          event: 'error',
          data: {
            code: 'MOTIR_AI_UNAVAILABLE',
            message: 'motir-ai is unavailable: the planner model stopped answering',
          },
        },
        jobDone,
      ]),
    );
    // The failed attempt's session is ended, once — not once per window.
    expect(endSessionForFailedJob).toHaveBeenCalledTimes(1);
  });

  it('a stream that ends on its own terminal done is subscribed ONCE', async () => {
    const fetchMock = motirAi([[status('running'), progress(1), status('succeeded'), jobDone]]);
    const res = await streamReq('job-1');
    await expect(res.text()).resolves.toBe(
      sse([status('running'), progress(1), status('succeeded'), jobDone]),
    );
    expect(streamOpens(fetchMock)).toBe(1);
  });
});

describe('followJobStream', () => {
  async function collect(windows: JobStreamEvent[][]): Promise<JobStreamEvent[]> {
    let i = 0;
    const out: JobStreamEvent[] = [];
    for await (const f of followJobStream(async function* () {
      for (const frame of windows[i++] ?? []) yield frame;
    }))
      out.push(f);
    return out;
  }

  it('relays a status CHANGE across windows, and drops only a repeat', async () => {
    expect(
      await collect([
        [status('queued'), windowClosed],
        [status('running'), progress(1), windowClosed],
        [status('running'), progress(1), progress(2), status('canceled'), jobDone],
      ]),
    ).toEqual([
      status('queued'),
      status('running'),
      progress(1),
      progress(2),
      status('canceled'),
      jobDone,
    ]);
  });

  it('stops on an error frame, an upstream close, or a terminal done — never re-subscribes on them', async () => {
    const problem: JobStreamEvent = { event: 'error', data: { code: 'not_found' } };
    expect(
      await collect([
        [status('running'), problem],
        [status('succeeded'), jobDone],
      ]),
    ).toEqual([status('running'), problem]);
    expect(await collect([[status('running')], [status('succeeded'), jobDone]])).toEqual([
      status('running'),
    ]);
  });
});
