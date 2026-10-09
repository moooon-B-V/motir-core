// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// A FINISHED ask, and the Stop pressed before the planner hands off (bug MOTIR-7924).
//
// Three defects shared one root: an answered ask never closed its record. Its
// opening `reading` act stayed on the rail under the answer ("Reading your
// request…" — phrased as ongoing), and its job id stayed in state, so the Stop
// pressed during the NEXT run's submit posted the finished ask's id and was
// refused. And when the correction's plan job did arrive, its branch reset the
// stop flags, so a Stop pressed in that window was dropped for good.
//
// What is asserted here is the STATE the rail and the Stop read — never a render.

const {
  open,
  submitAsk,
  rerunAsk,
  settleAsk,
  streamAsk,
  stream,
  fetchReview,
  stopRun,
  readPending,
} = vi.hoisted(() => ({
  open: vi.fn(),
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
  stopRun: vi.fn(),
  readPending: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  appendPlanChangeTurn: vi.fn(),
  submitPlanChange: vi.fn(),
  recordPlannerTurn: vi.fn(async () => session(['x'])),
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: submitAsk,
  rerunAskTurn: rerunAsk,
  settleAskJob: settleAsk,
  stopPlanChangeRun: stopRun,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAskJob: streamAsk,
    streamAugmentJob: stream,
    streamContextualPlanJob: vi.fn(),
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview };
});

// The settle's proposal read: a stopped correction proposed nothing.
vi.mock('@/lib/planning/planReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planReview')>()),
  readPendingProposal: readPending,
}));

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';

/** A promise a test resolves by hand — how a run is held mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(bodies: string[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: 'ask' as const,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-08-20T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

const ANSWERED = session(['which stories are blocked?']);

/** The correction's door answer when the flip makes it a plan change. */
const FLIPPED = {
  outcome: 'redirected' as const,
  jobId: 'job-plan-1',
  planId: 'plan-1',
  session: ANSWERED,
};

beforeEach(() => {
  open.mockResolvedValue(session([]));
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([body]),
  }));
  settleAsk.mockResolvedValue({ outcome: 'answered', session: ANSWERED });
  streamAsk.mockImplementation(async () => {});
  stream.mockImplementation(async () => {});
  fetchReview.mockResolvedValue(null);
  stopRun.mockResolvedValue({ turns: [], stopped: true });
  readPending.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function answered() {
  const hook = renderHook(() => usePlanChangeConversation({}));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  await act(async () => {
    await hook.result.current.send('which stories are blocked?');
  });
  expect(hook.result.current.state.phase).toBe('idle');
  return hook;
}

describe('an ANSWERED ask closes its record', () => {
  it('leaves no `reading` act on the rail, and no job id behind it', async () => {
    const { result } = await answered();

    expect(result.current.state.acts).toEqual([]);
    expect(result.current.state.progress).toBeNull();
    expect(result.current.state.jobId).toBeNull();
  });

  it('a SILENT ask closes it the same way', async () => {
    settleAsk.mockResolvedValue({ outcome: 'silent', session: ANSWERED });
    const { result } = await answered();

    expect(result.current.state.errorCode).toBe('ASK_SILENT');
    expect(result.current.state.acts).toEqual([]);
    expect(result.current.state.jobId).toBeNull();
  });

  it('a FAILED ask stream does not leave it reading either', async () => {
    streamAsk.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('ASK_FAILED');
      },
    );
    const { result } = await answered();

    expect(result.current.state.errorCode).toBe('ASK_FAILED');
    expect(result.current.state.acts).toEqual([]);
  });
});

describe('a Stop pressed before the planner hands off stops the PLAN run', () => {
  // A turn becomes a planning run only when the PLANNER reads it as one
  // (`conversation-turn-intent.md` AMENDMENT 3): at the door, or when the ask job
  // settles as a redirect. Either way the plan job's id arrives AFTER the person
  // may already have pressed Stop, and the stop must land on that job.
  it('⚠️ pressed while the turn’s POST is pending, it is raised on the plan job once its id is known', async () => {
    const { result } = await answered();
    const door = deferred<typeof FLIPPED>();
    submitAsk.mockReturnValueOnce(door.promise);
    // Hold the plan run open so the stop can be observed landing on it.
    const planStream = deferred<void>();
    stream.mockImplementationOnce(async () => planStream.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('split the payments epic');
    });
    expect(result.current.state.phase).toBe('streaming');

    await act(async () => {
      await result.current.stop();
    });
    // NOTHING was posted against the finished ask — its id names no live run.
    expect(stopRun).not.toHaveBeenCalled();
    expect(result.current.state.stopping).toBe(true);

    await act(async () => {
      door.resolve(FLIPPED);
      await Promise.resolve();
    });
    await waitFor(() => expect(stopRun).toHaveBeenCalledTimes(1));
    expect(stopRun).toHaveBeenCalledWith('s1', 'job-plan-1', 'stop:job-plan-1');
    // The bar keeps saying "stopping" — the flags were carried, not reset.
    expect(result.current.state.jobId).toBe('job-plan-1');
    expect(result.current.state.stopping).toBe(true);

    await act(async () => {
      planStream.resolve();
      await sending;
    });
    // …and the run ends STOPPED, not EMPTY.
    expect(result.current.state.stopped).toBe(true);
    expect(result.current.state.stopping).toBe(false);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('pressed while the ASK job streams, it is raised on the plan job the ask hands off to', async () => {
    const { result } = await answered();
    submitAsk.mockResolvedValueOnce({ jobId: 'ask-2', turnId: 't1', session: ANSWERED });
    const askStream = deferred<void>();
    streamAsk.mockImplementationOnce(async () => askStream.promise);
    settleAsk.mockResolvedValueOnce(FLIPPED);
    const planStream = deferred<void>();
    stream.mockImplementationOnce(async () => planStream.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('split the payments epic');
    });
    await waitFor(() => expect(result.current.state.jobId).toBe('ask-2'));

    await act(async () => {
      await result.current.stop();
    });
    // The ask job is not something the stop door can address.
    expect(stopRun).not.toHaveBeenCalled();

    await act(async () => {
      askStream.resolve();
    });
    await waitFor(() =>
      expect(stopRun).toHaveBeenCalledWith('s1', 'job-plan-1', 'stop:job-plan-1'),
    );

    await act(async () => {
      planStream.resolve();
      await sending;
    });
    expect(result.current.state.stopped).toBe(true);
  });

  it('a pending stop on a turn that only ANSWERS clears with the answer', async () => {
    const { result } = await answered();
    const door = deferred<{ jobId: string; turnId: string; session: PlanChangeSessionDto }>();
    submitAsk.mockReturnValueOnce(door.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('and which are late?');
    });
    await act(async () => {
      await result.current.stop();
    });
    await act(async () => {
      door.resolve({ jobId: 'ask-2', turnId: 't1', session: ANSWERED });
      await sending;
    });

    expect(stopRun).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.stopping).toBe(false);
    expect(result.current.state.stopped).toBe(false);
  });

  it('a hand-off with NO stop pressed runs unstopped', async () => {
    const { result } = await answered();
    submitAsk.mockResolvedValueOnce(FLIPPED);

    await act(async () => {
      await result.current.send('split the payments epic');
    });

    expect(stopRun).not.toHaveBeenCalled();
    expect(result.current.state.stopped).toBe(false);
    expect(result.current.state.stopping).toBe(false);
  });
});
