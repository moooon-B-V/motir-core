// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// MOTIR-9255 — THE PLANNING AND ASK RAILS WHILE A SUBMIT WAITS ON A WAKING MOTIR AI.
//
// The server re-sends a turn's submit under one key for up to 90 s while a
// suspended conversation machine wakes. Past 8 s the rail says Motir AI is
// starting up — an act, never an error — and takes it back down the moment the
// submit answers. A submit whose budget ran out surfaces as its own typed code.

const { open, submitAsk, settleAsk, streamAsk } = vi.hoisted(() => ({
  open: vi.fn(),
  submitAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  appendPlanChangeTurn: vi.fn(),
  submitPlanChange: vi.fn(),
  recordPlannerTurn: vi.fn(),
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: submitAsk,
  rerunAskTurn: vi.fn(),
  settleAskJob: settleAsk,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAskJob: streamAsk,
    streamAugmentJob: vi.fn(),
    streamContextualPlanJob: vi.fn(),
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: vi.fn(async () => null) };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { MOTIR_AI_UNAVAILABLE, STARTING_UP_AFTER_MS } from '@/lib/planning/submitStartingUp';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
const SUBMITTED = { jobId: 'ask-1', turnId: 't0', session: ANSWERED };

beforeEach(() => {
  open.mockResolvedValue(session([]));
  settleAsk.mockResolvedValue({ outcome: 'answered', session: ANSWERED });
  streamAsk.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({}));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

const hasStarting = (acts: { kind: string }[]) => acts.some((a) => a.kind === 'starting');

describe('a submit that waits on a waking Motir AI (MOTIR-9255)', () => {
  it('says "starting up" past the delay, then takes it down when the submit answers', async () => {
    const { result } = await mounted();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const held = deferred<typeof SUBMITTED>();
    submitAsk.mockReturnValueOnce(held.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('which stories are blocked?');
    });
    await waitFor(() => expect(submitAsk).toHaveBeenCalledTimes(1));
    expect(hasStarting(result.current.state.acts)).toBe(false);

    act(() => {
      vi.advanceTimersByTime(STARTING_UP_AFTER_MS);
    });
    expect(result.current.state.progress).toEqual({ kind: 'starting' });
    expect(hasStarting(result.current.state.acts)).toBe(true);
    expect(result.current.state.errorCode).toBeNull();

    await act(async () => {
      held.resolve(SUBMITTED);
      await sending;
    });

    expect(hasStarting(result.current.state.acts)).toBe(false);
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.errorCode).toBeNull();
  });

  it('a submit that answers quickly never says it', async () => {
    submitAsk.mockResolvedValueOnce(SUBMITTED);
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('which stories are blocked?');
    });

    expect(hasStarting(result.current.state.acts)).toBe(false);
    expect(result.current.state.phase).toBe('idle');
  });

  it('a submit whose budget ran out is the typed MOTIR_AI_UNAVAILABLE, not the catch-all', async () => {
    submitAsk.mockRejectedValueOnce(new PlanEditsClientError(502, MOTIR_AI_UNAVAILABLE));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('which stories are blocked?');
    });

    expect(result.current.state.errorCode).toBe(MOTIR_AI_UNAVAILABLE);
    expect(hasStarting(result.current.state.acts)).toBe(false);
  });

  it('another refusal keeps its own code', async () => {
    submitAsk.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('which stories are blocked?');
    });

    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('a rail closed while it waits writes nothing after it is gone', async () => {
    const { result, unmount } = await mounted();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const held = deferred<typeof SUBMITTED>();
    submitAsk.mockReturnValueOnce(held.promise);

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('which stories are blocked?');
    });
    await waitFor(() => expect(submitAsk).toHaveBeenCalledTimes(1));
    unmount();

    vi.advanceTimersByTime(STARTING_UP_AFTER_MS);
    held.resolve(SUBMITTED);
    await expect(sending).resolves.toBeUndefined();
  });
});
