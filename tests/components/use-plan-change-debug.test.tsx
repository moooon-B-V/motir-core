// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// MOTIR-7050 — the DEBUG arm of the conversation loop, as the hook drives it:
// the widget's anchored send, the hand-off to the `debug_bug` job and its
// narrated acts, the landing the rail's outcome line reads, the Triage tick —
// and the RETRY gap this card closes: a re-run the ask door hands straight back
// as `debugging` used to be streamed as a plan edit.
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

import {
  narrateDebugFrame,
  usePlanChangeConversation,
} from '@/lib/hooks/usePlanChangeConversation';

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
      intent: 'debug' as const,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-09-30T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

const LANDED = {
  outcome: 'debugged' as const,
  landing: {
    outcome: 'diagnose' as const,
    workItemKey: 'PROD-412',
    title: 'Board drag drops the card one column short',
    createdInTriage: false,
  },
  session: session([REPORT], 'debug-1'),
};

type OnFrame = (event: string, data: unknown) => void;
type OnError = (code: string | null) => void;

beforeEach(() => {
  open.mockResolvedValue(session([]));
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session([body], 'ask-1'),
  }));
  // The ask job settles as a REPORT; the debug job's own settle lands it.
  settleAsk.mockImplementation(async (jobId: string) =>
    jobId === 'ask-1'
      ? { outcome: 'debugging', jobId: 'debug-1', session: session([REPORT], 'debug-1') }
      : LANDED,
  );
  streamAsk.mockImplementation(
    async (jobId: string, _signal: AbortSignal, _onError: OnError, _onDone, onFrame?: OnFrame) => {
      if (jobId === 'ask-1') return;
      onFrame?.('retrieval', { family: 'code_graph' });
      onFrame?.('status', { phase: 'grounding' });
      onFrame?.('status', { phase: 'searching', groundingReason: 'indexed' });
      onFrame?.('status', {
        phase: 'diagnosed',
        outcome: 'diagnose',
        groundingReason: 'indexed',
      });
    },
  );
  streamAugment.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted(onTriageChanged?: () => void) {
  const hook = renderHook(() =>
    usePlanChangeConversation(onTriageChanged ? { onTriageChanged } : {}),
  );
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

describe('the debug run', () => {
  it('hands off to the debug job, narrates its acts, and records what it LANDED', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send(REPORT, [], { anchorKey: 'PROD-412' });
    });

    // The debug job streamed through the ASK stream — never the plan-edit one.
    expect(streamAsk.mock.calls.map((c) => c[0])).toEqual(['ask-1', 'debug-1']);
    expect(streamAugment).not.toHaveBeenCalled();
    expect(settleAsk).toHaveBeenLastCalledWith('debug-1', expect.anything(), 's1');

    expect(result.current.state.acts).toEqual([
      { kind: 'reading' },
      { kind: 'redirectedDebug' },
      { kind: 'retrieval', family: 'code_graph', blocked: false },
      { kind: 'matching' },
      { kind: 'writing', key: 'PROD-412' },
    ]);
    expect(result.current.state.debugLandings).toEqual({ 'debug-1': LANDED.landing });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.session).toEqual(LANDED.session);
  });

  it('bumps the Triage tick only when the landing FILED a bug', async () => {
    const onTriageChanged = vi.fn();
    settleAsk.mockImplementation(async (jobId: string) =>
      jobId === 'ask-1'
        ? { outcome: 'debugging', jobId: 'debug-1', session: session([REPORT], 'debug-1') }
        : {
            ...LANDED,
            landing: { ...LANDED.landing, workItemKey: 'PROD-414', createdInTriage: true },
          },
    );
    const { result } = await mounted(onTriageChanged);

    await act(async () => {
      await result.current.send('the board drops cards one column short');
    });

    expect(onTriageChanged).toHaveBeenCalledTimes(1);
  });

  it('an out-of-credits debug job is the paywall state, not an error', async () => {
    streamAsk.mockImplementation(async (jobId: string, _s: AbortSignal, onError: OnError) => {
      if (jobId === 'debug-1') onError('MOTIR_AI_OUT_OF_CREDITS');
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send(REPORT, [], { anchorKey: 'PROD-412' });
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('idle');
  });
});

describe('the RETRY path — a re-run that comes back `debugging`', () => {
  async function failedDebugRun() {
    // The debug job's stream fails once, leaving a retryable error.
    streamAsk.mockImplementationOnce(async () => {}); // the ask job
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

  it('follows the debug job — the ask stream and the debug settle — not the plan-edit tail', async () => {
    const { result } = await failedDebugRun();
    rerunAsk.mockResolvedValueOnce({
      outcome: 'debugging',
      jobId: 'debug-2',
      session: session([REPORT], 'debug-2'),
    });
    settleAsk.mockResolvedValueOnce({ ...LANDED, session: session([REPORT], 'debug-2') });
    streamAsk.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    // It re-ran the SAME turn, and carried the SAME anchor, so the diagnosis is
    // still about the triage bug the report filed — not a second bug.
    expect(rerunAsk).toHaveBeenCalledTimes(1);
    expect(rerunAsk.mock.calls[0]?.[0]).toBe('t0');
    expect(rerunAsk.mock.calls[0]?.[1]).toMatchObject({ anchorKey: 'PROD-412' });
    expect(rerunAsk.mock.calls[0]?.[1]).not.toHaveProperty('flip');

    expect(streamAsk.mock.calls.map((c) => c[0])).toEqual(['debug-2']);
    expect(streamAugment).not.toHaveBeenCalled();
    expect(settleAsk).toHaveBeenLastCalledWith('debug-2', expect.anything(), 's1');

    expect(result.current.state.planId).toBeNull();
    expect(result.current.state.acts[0]).toEqual({ kind: 'redirectedDebug' });
    expect(result.current.state.debugLandings?.['debug-2']).toEqual(LANDED.landing);
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.errorCode).toBeNull();
  });

  it('a second retry still names the same turn and anchor', async () => {
    const { result } = await failedDebugRun();
    rerunAsk.mockResolvedValue({
      outcome: 'debugging',
      jobId: 'debug-2',
      session: session([REPORT], 'debug-2'),
    });
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

describe('narrateDebugFrame', () => {
  it('reads the phases as the design’s two acts, and nothing else as one', () => {
    expect(narrateDebugFrame('status', { phase: 'searching' }, null)).toEqual({ kind: 'matching' });
    expect(narrateDebugFrame('status', { phase: 'grounding' }, 'PROD-412')).toBeNull();
    expect(narrateDebugFrame('status', { phase: 'authoring' }, 'PROD-412')).toBeNull();
  });

  it('names the write only when the card is certain: anchored, diagnose, grounded', () => {
    const diagnosed = { phase: 'diagnosed', outcome: 'diagnose', groundingReason: 'indexed' };
    expect(narrateDebugFrame('status', diagnosed, 'PROD-412')).toEqual({
      kind: 'writing',
      key: 'PROD-412',
    });
    // The orb path: the bug is filed by the settle, so its key is not known yet.
    expect(narrateDebugFrame('status', diagnosed, null)).toBeNull();
    // An enrichment writes to a card only the settle names.
    expect(
      narrateDebugFrame('status', { ...diagnosed, outcome: 'enrich_existing' }, 'PROD-412'),
    ).toBeNull();
    // An ungrounded report writes nothing.
    expect(
      narrateDebugFrame('status', { ...diagnosed, groundingReason: 'no_match' }, 'PROD-412'),
    ).toBeNull();
  });

  it('passes every other frame to the shipped narration', () => {
    expect(narrateDebugFrame('retrieval', { family: 'plan_tree' }, null)).toEqual({
      kind: 'retrieval',
      family: 'plan_tree',
      blocked: false,
    });
  });
});
