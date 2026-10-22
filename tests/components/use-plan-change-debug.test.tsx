// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// A REPORT OF BROKEN BEHAVIOUR is an ordinary ask turn (ADR conversation-turn-intent
// AMENDMENT 5 · MOTIR-9232): the widget's anchored send goes through the ask door,
// the first act the rail draws is `reading`, nothing names a classifying step or a
// debug hand-off, and a retry keeps the anchor the turn was sent with. A settle
// result the server no longer produces (`debugging`, `debugged`, `confirming`) from
// a stale deploy is ignored rather than drawn as an error.
//
// The door and the streams are mocked at the client module, the way
// `use-plan-change-ask.test.tsx` mocks them.

const { open, submitAsk, rerunAsk, settleAsk, streamAsk, streamAugment } = vi.hoisted(() => ({
  open: vi.fn(),
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  streamAugment: vi.fn(),
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
  rerunAskTurn: rerunAsk,
  settleAskJob: settleAsk,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAskJob: streamAsk,
    streamAugmentJob: streamAugment,
    streamContextualPlanJob: vi.fn(),
  };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';

const REPORT = 'Board drag drops the card one column short\n\nIt lands one column left.';

function session(bodies: string[], jobId: string | null = null): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-30T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-30T09:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId,
      question: null,
      isAnswer: false,
      intent: 'ask' as const,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-09-30T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

type OnFrame = (event: string, data: unknown) => void;
type OnError = (code: string | null) => void;

/** What the ask stream emits before it settles — `null` streams nothing. */
let frames: Array<[string, unknown]> = [];

beforeEach(() => {
  frames = [];
  open.mockResolvedValue(session([]));
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([body], 'ask-1'),
  }));
  settleAsk.mockImplementation(async () => ({
    outcome: 'answered',
    session: session([REPORT], 'ask-1'),
  }));
  streamAsk.mockImplementation(
    async (_jobId: string, _signal: AbortSignal, _onError: OnError, _onDone, onFrame?: OnFrame) => {
      for (const [event, data] of frames) onFrame?.(event, data);
    },
  );
  streamAugment.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation());
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('the widget’s anchored send', () => {
  it('goes through the ASK DOOR with the triage bug as its anchor, and remembers it on the turn', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send(REPORT, [], { anchorKey: 'PROD-412' });
    });

    expect(submitAsk).toHaveBeenCalledTimes(1);
    // body, signal, isAnswer, session, seed gate, ANCHOR — and no intent anywhere.
    expect(submitAsk.mock.calls[0]?.[0]).toBe(REPORT);
    expect(submitAsk.mock.calls[0]?.[5]).toBe('PROD-412');
    expect(result.current.state.turnAnchors).toEqual({ t0: 'PROD-412' });
  });

  it('sends no anchor on an ordinary composer turn', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('why is the board slow?');
    });
    expect(submitAsk.mock.calls[0]?.[5]).toBeNull();
    expect(result.current.state.turnAnchors).toEqual({});
  });
});

describe('a report is READ: the rail goes straight to reading (MOTIR-9232)', () => {
  it('the first act after submit is `reading`, and no frame adds a classifying or debug act', async () => {
    // Frames a stale motir-ai, or the debug job this story retired, could still send.
    frames = [
      ['status', { phase: 'classifying' }],
      ['status', { phase: 'searching', groundingReason: 'indexed' }],
      ['status', { phase: 'diagnosed', outcome: 'diagnose', groundingReason: 'indexed' }],
      ['retrieval', { family: 'code_graph' }],
    ];
    const seen: string[][] = [];
    let release: () => void = () => {};
    settleAsk.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ outcome: 'answered', session: session([REPORT], 'ask-1') });
        }),
    );
    const { result } = await mounted();

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.send(REPORT, [], { anchorKey: 'PROD-412' });
    });
    await waitFor(() => expect(settleAsk).toHaveBeenCalled());
    seen.push(result.current.state.acts.map((a) => a.kind));

    expect(seen[0]).toEqual(['reading']);
    expect(result.current.state.progress).toEqual({ kind: 'reading' });
    expect(result.current.state.errorCode).toBeNull();

    await act(async () => {
      release();
      await sent;
    });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.errorCode).toBeNull();
    expect(streamAugment).not.toHaveBeenCalled();
  });

  it.each(['debugging', 'debugged', 'confirming'])(
    'a stale `%s` settle result is ignored: no error state, no plan run, no debug stream',
    async (outcome) => {
      settleAsk.mockImplementationOnce(async () => ({
        outcome,
        jobId: 'debug-1',
        landing: {
          outcome: 'diagnose',
          workItemKey: 'PROD-412',
          title: 'x',
          createdInTriage: false,
        },
        session: session([REPORT], 'ask-1'),
      }));
      const { result } = await mounted();

      await act(async () => {
        await result.current.send(REPORT);
      });

      expect(result.current.state.phase).toBe('idle');
      expect(result.current.state.errorCode).toBeNull();
      expect(result.current.state.planId).toBeNull();
      expect(streamAsk.mock.calls.map((c) => c[0])).toEqual(['ask-1']);
      expect(streamAugment).not.toHaveBeenCalled();
      expect(result.current.state.debugLandings).toEqual({});
    },
  );
});

describe('the RETRY path keeps the turn and its anchor', () => {
  async function failedRun() {
    streamAsk.mockImplementationOnce(async (_j: string, _s: AbortSignal, onError: OnError) => {
      onError(null);
    });
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send(REPORT, [], { anchorKey: 'PROD-412' });
    });
    expect(hook.result.current.state.errorCode).toBe('FAILED');
    return hook;
  }

  it('re-runs the same turn with the same anchor, as an ask', async () => {
    const { result } = await failedRun();
    rerunAsk.mockResolvedValueOnce({ jobId: 'ask-2', turnId: 't0', session: session([REPORT]) });
    streamAsk.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    expect(rerunAsk).toHaveBeenCalledTimes(1);
    expect(rerunAsk.mock.calls[0]?.[0]).toBe('t0');
    expect(rerunAsk.mock.calls[0]?.[1]).toMatchObject({ anchorKey: 'PROD-412' });
    expect(rerunAsk.mock.calls[0]?.[1]).not.toHaveProperty('flip');
    expect(streamAsk.mock.calls.map((c) => c[0])).toEqual(['ask-2']);
    expect(settleAsk).toHaveBeenLastCalledWith('ask-2', expect.anything(), 's1');
    expect(result.current.state.acts.map((a) => a.kind)).not.toContain('redirected');
    expect(result.current.state.errorCode).toBeNull();
  });

  it('a second retry still names the same turn and anchor', async () => {
    const { result } = await failedRun();
    rerunAsk.mockResolvedValue({ jobId: 'ask-2', turnId: 't0', session: session([REPORT]) });
    streamAsk.mockImplementationOnce(async (_j: string, _s: AbortSignal, onError: OnError) => {
      onError(null);
    });

    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.state.errorCode).toBe('FAILED');

    await act(async () => {
      await result.current.retry();
    });
    expect(rerunAsk).toHaveBeenCalledTimes(2);
    expect(rerunAsk.mock.calls[1]?.[0]).toBe('t0');
    expect(rerunAsk.mock.calls[1]?.[1]).toMatchObject({ anchorKey: 'PROD-412' });
  });

  it('the correction ("Answer this instead") keeps the turn’s anchor too', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send(REPORT, [], { anchorKey: 'PROD-412' });
    });
    rerunAsk.mockResolvedValueOnce({ jobId: 'ask-9', turnId: 't0', session: session([REPORT]) });
    settleAsk.mockResolvedValueOnce({ outcome: 'answered', session: session([REPORT]) });

    await act(async () => {
      await result.current.correctTurn('t0');
    });

    expect(rerunAsk.mock.calls[0]?.[1]).toMatchObject({ flip: true, anchorKey: 'PROD-412' });
  });
});
