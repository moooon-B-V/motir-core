// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The conversation LOOP (Subtask MOTIR-1730): open/resume → append a turn →
// submit the ACCUMULATED intent → stream → review the delta → approve or discard.
// The session seam (MOTIR-1728) and the shipped job helpers are mocked, so what
// is under test is the state machine the rail and the canvas both read.

const { open, append, submit, stream, fetchResult, approve } = vi.hoisted(() => ({
  open: vi.fn(),
  append: vi.fn(),
  submit: vi.fn(),
  stream: vi.fn(),
  fetchResult: vi.fn(),
  approve: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  openPlanChangeSession: open,
  appendPlanChangeTurn: append,
  submitPlanChange: submit,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
    fetchJobResult: fetchResult,
    approvePlanDelta: approve,
  };
});

import { usePlanChangeConversation, narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

function session(bodies: string[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      authorId: 'u1',
      createdAt: '2026-07-27T10:00:00.000Z',
    })),
  };
}

const DELTA = {
  operations: [{ op: 'create' as const, kind: 'story' as const, fields: { title: 'Recurring' } }],
};

/** A stream that immediately reports success, optionally emitting progress frames. */
function okStream(frames: Array<[string, unknown]> = []) {
  return vi.fn(
    async (
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      _onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
    ) => {
      for (const [event, data] of frames) onFrame?.(event, data);
    },
  );
}

beforeEach(() => {
  open.mockResolvedValue(session([]));
  append.mockImplementation(async (body: string) => session([body]));
  submit.mockResolvedValue({ jobId: 'job-1', session: session(['Add recurring invoices.']) });
  stream.mockImplementation(okStream());
  fetchResult.mockResolvedValue({ status: 'succeeded', result: { planDelta: DELTA } });
  approve.mockResolvedValue({ created: ['PAY-30'], updated: [], unchanged: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted(onApproved?: (r: unknown) => void) {
  const hook = renderHook(() =>
    usePlanChangeConversation(onApproved ? { onApproved: onApproved as never } : {}),
  );
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('usePlanChangeConversation — resume', () => {
  it('opens (or RESUMES) the project thread on mount', async () => {
    open.mockResolvedValue(session(['Add recurring invoices.', 'Split it in two.']));
    const { result } = await mounted();

    expect(open).toHaveBeenCalledTimes(1);
    expect(result.current.state.session?.turns).toHaveLength(2);
  });

  it('degrades to a recoverable error when the thread cannot be read', async () => {
    open.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
  });
});

describe('usePlanChangeConversation — a turn', () => {
  it('appends the turn, then submits the ACCUMULATED intent and reviews the delta', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(append).toHaveBeenCalledWith('Add recurring invoices.', expect.anything());
    // The submit takes NO prompt — the server builds it from every turn in order.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.delta).toEqual(DELTA);
    expect(result.current.state.jobId).toBe('job-1');
  });

  it('ignores an empty turn — nothing is appended and nothing is submitted', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('   ');
    });

    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('narrates the run from the job’s REAL progress frames', async () => {
    stream.mockImplementation(okStream([['search', { relatedCount: 3 }]]));
    const { result } = await mounted();

    // Freeze the run mid-stream by asserting the frame mapping directly — the
    // narration is derived, not invented.
    expect(narrateFrame('search', {})).toEqual({ kind: 'searching' });
    expect(narrateFrame('planned', { proposed: 2 })).toEqual({ kind: 'proposed', count: 2 });
    expect(narrateFrame('tokens', {})).toBeNull();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    // Settled → the narration clears; the delta is the outcome.
    expect(result.current.state.progress).toBeNull();
  });

  it('reports an EMPTY result without losing the thread', async () => {
    fetchResult.mockResolvedValue({
      status: 'succeeded',
      result: { planDelta: { operations: [] } },
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBe('EMPTY');
    expect(result.current.state.session?.turns).toHaveLength(1);
  });
});

describe('usePlanChangeConversation — failure is recoverable in place', () => {
  it('keeps a PRIOR proposal and the thread when a later run fails', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    stream.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) =>
        onError('FAILED'),
    );
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.errorCode).toBe('FAILED');
    // The proposal already on the canvas survives — a retry continues the
    // conversation instead of restarting it.
    expect(result.current.state.delta).toEqual(DELTA);
    expect(result.current.state.phase).toBe('review');
  });

  it('flags an out-of-credits refusal as GATED, not as an error', async () => {
    submit.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('re-sends the accumulated intent on retry WITHOUT appending a new turn', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    append.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    expect(append).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe('usePlanChangeConversation — approve / discard', () => {
  it('persists through the shipped approve route and KEEPS the conversation open', async () => {
    const onApproved = vi.fn();
    const { result } = await mounted(onApproved);
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(approve).toHaveBeenCalledWith('job-1', DELTA);
    expect(result.current.state.delta).toBeNull();
    expect(result.current.state.approved).toEqual({
      created: ['PAY-30'],
      updated: [],
      unchanged: [],
    });
    // The thread survives the commit — that is what makes it a conversation.
    expect(result.current.state.session?.turns).toHaveLength(1);
    // The caller is told, so it can refresh the server surfaces AND the island.
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it('surfaces an immutable rejection and leaves the proposal in review', async () => {
    approve.mockRejectedValue(new PlanEditsClientError(409, 'PLAN_DELTA_IMMUTABLE'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('immutable');
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.delta).toEqual(DELTA);
  });

  it('DISCARD writes nothing and leaves the thread intact', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    act(() => {
      result.current.discard();
    });

    expect(approve).not.toHaveBeenCalled();
    expect(result.current.state.delta).toBeNull();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.session?.turns).toHaveLength(1);
  });
});
