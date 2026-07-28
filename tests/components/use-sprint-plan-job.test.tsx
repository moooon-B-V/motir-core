// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSprintPlanJob } from '@/lib/hooks/useSprintPlanJob';
import type { SprintAssignmentDelta } from '@/lib/ai/types';

// The AI sprint-planning RUN, as the browser drives it (Subtask MOTIR-1750).
// DB-free: the four HTTP seams are stubbed, so what these lock is the CLIENT
// contract — which requests fire, in what order, with what body, and above all
// WHICH ONE WRITES.
//
//   * submit → stream → review is the read path; none of it writes.
//   * APPROVE is the only write, and it carries the delta the review RENDERED,
//     so what persists is exactly what the human saw.
//   * DISCARD issues no request at all — "writes nothing" is not a server
//     behaviour to trust here, it is the absence of a call.
//   * each shipped status code lands on its own drawn failure.

const DELTA: SprintAssignmentDelta = {
  deltaVersion: 'v1',
  sprintLengthDays: 7,
  capacityMinutes: 1680,
  agentMinutesPerDay: 240,
  sprints: [
    {
      tempId: 'sprint:1',
      name: 'Sprint 2',
      lengthDays: 7,
      itemKeys: ['MOTIR-920'],
      totalEstimateMinutes: 50,
      capacityMinutes: 1680,
      oversizedKeys: [],
      rationale: 'unblocked first',
    },
  ],
  itemCount: 1,
  totalEstimateMinutes: 50,
  unestimatedKeys: [],
  oversizedKeys: [],
};

const REVIEW = {
  jobStatus: 'succeeded',
  proposal: DELTA,
  items: {
    'MOTIR-920': {
      item: { id: 'wi_1', identifier: 'MOTIR-920', title: 'A', kind: 'subtask', status: 'todo' },
      blockedByKeys: [],
    },
  },
};

/** An SSE body carrying the handler's real frames, then the terminal `done`. */
function sseBody(frames: Array<[string, unknown]>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of frames) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
      controller.close();
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface StubOptions {
  submit?: () => Response;
  review?: () => Response;
  approve?: () => Response;
  frames?: Array<[string, unknown]>;
}

/** Route each seam; returns the recorded calls so a test can assert absence. */
function stubFetch(options: StubOptions = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (url === '/api/ai/plan/sprint' && method === 'POST') {
      return options.submit ? options.submit() : json({ jobId: 'job_1' });
    }
    if (url.endsWith('/stream')) {
      return new Response(sseBody(options.frames ?? [['read', { packing: 9 }]]), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (url.endsWith('/review')) {
      return options.review ? options.review() : json(REVIEW);
    }
    if (url === '/api/ai/plan/sprint/approve') {
      return options.approve
        ? options.approve()
        : json({
            sprints: [{ tempId: 'sprint:1', id: 'sp_1', name: 'Sprint 4', assignedCount: 1 }],
            assigned: 1,
          });
    }
    throw new Error(`unstubbed fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useSprintPlanJob — the read path (MOTIR-1750)', () => {
  it('submits, streams, then lands on the review with the resolved proposal', async () => {
    const calls = stubFetch();
    const { result } = renderHook(() => useSprintPlanJob());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    expect(result.current.state.jobId).toBe('job_1');
    expect(result.current.state.review?.proposal).toEqual(DELTA);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/ai/plan/sprint',
      'GET /api/ai/plan/sprint/job_1/stream',
      'GET /api/ai/plan/sprint/job_1/review',
    ]);
    // The read path WRITES NOTHING — no approve, ever, without the click.
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);
  });

  it('narrates progress from the real frames, deriving the per-day budget', async () => {
    stubFetch({
      frames: [
        ['read', { treeItems: 20, schedulable: 9, packing: 9 }],
        ['packed', { sprints: 3, items: 9, sprintLengthDays: 7, capacityMinutes: 1680 }],
      ],
    });
    const { result } = renderHook(() => useSprintPlanJob());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    expect(result.current.state.progress).toEqual({
      readCount: 9,
      sprintLengthDays: 7,
      // 1680 / 7 — the delta DEFINES capacity as days × per-day, so the budget
      // is recoverable from the frame rather than needing a field it lacks.
      agentMinutesPerDay: 240,
      sprintCount: 3,
    });
  });

  it('reports an EMPTY packing as its own phase, not a failure', async () => {
    stubFetch({
      review: () =>
        json({
          jobStatus: 'succeeded',
          proposal: { ...DELTA, sprints: [], itemCount: 0 },
          items: {},
        }),
    });
    const { result } = renderHook(() => useSprintPlanJob());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('empty'));
    expect(result.current.state.failure).toBeNull();
  });
});

describe('useSprintPlanJob — approve is the only write (MOTIR-1750)', () => {
  it('POSTs the REVIEWED delta and reports what was created', async () => {
    const calls = stubFetch();
    const onApproved = vi.fn();
    const { result } = renderHook(() => useSprintPlanJob({ onApproved }));

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    await act(async () => {
      await result.current.approve('job_1', result.current.state.review!.proposal!);
    });

    const approveCall = calls.find((c) => c.url.endsWith('/approve'));
    expect(approveCall?.method).toBe('POST');
    // Exactly what the review rendered — not a re-packed or re-derived delta.
    expect(approveCall?.body).toEqual({ jobId: 'job_1', approvedDelta: DELTA });
    expect(onApproved).toHaveBeenCalledWith({
      sprints: [{ tempId: 'sprint:1', id: 'sp_1', name: 'Sprint 4', assignedCount: 1 }],
      assigned: 1,
    });
    // The dock must not linger showing a proposal that has become real.
    expect(result.current.state.phase).toBe('idle');
  });

  it('DISCARD writes nothing — it issues no request and leaves no state behind', async () => {
    const calls = stubFetch();
    const onApproved = vi.fn();
    const { result } = renderHook(() => useSprintPlanJob({ onApproved }));

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    const before = calls.length;
    act(() => result.current.dismiss());

    expect(calls).toHaveLength(before);
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);
    expect(onApproved).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ phase: 'idle', jobId: null, review: null });
  });

  it('keeps the review open on a REJECTED approve, quoting the server detail', async () => {
    stubFetch({
      approve: () =>
        json(
          { code: 'SPRINT_PLAN_APPROVE_ERROR', error: 'MOTIR-1750 is blocked by MOTIR-1749' },
          400,
        ),
    });
    const onApproved = vi.fn();
    const { result } = renderHook(() => useSprintPlanJob({ onApproved }));

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    await act(async () => {
      await result.current.approve('job_1', DELTA);
    });

    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.failure).toBe('packing');
    expect(result.current.state.failureDetail).toContain('MOTIR-1750 is blocked by MOTIR-1749');
    expect(onApproved).not.toHaveBeenCalled();
  });
});

describe('useSprintPlanJob — the failure taxonomy (MOTIR-1750)', () => {
  it.each([
    [409, 'SPRINT_PLANNING_DISABLED', 'disabled'],
    [402, 'MOTIR_AI_OUT_OF_CREDITS', 'credits'],
    [502, 'MOTIR_AI_UNAVAILABLE', 'unreachable'],
  ] as const)('maps a %s submit failure to the %s state', async (status, code, failure) => {
    const calls = stubFetch({ submit: () => json({ code, error: 'nope' }, status) });
    const { result } = renderHook(() => useSprintPlanJob());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state.phase).toBe('error');
    expect(result.current.state.failure).toBe(failure);
    // A refused submit never reached the stream, the review, or the write.
    expect(calls.map((c) => c.url)).toEqual(['/api/ai/plan/sprint']);
  });

  it('surfaces an out-of-credits ERROR FRAME mid-stream as the credits state', async () => {
    stubFetch({ frames: [['error', { code: 'MOTIR_AI_OUT_OF_CREDITS' }]] });
    const { result } = renderHook(() => useSprintPlanJob());

    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(result.current.state.failure).toBe('credits');
  });
});
