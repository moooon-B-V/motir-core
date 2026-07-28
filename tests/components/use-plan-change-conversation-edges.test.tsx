// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The story-level COVERAGE GATE's residual for the conversation state machine
// (MOTIR-1732). MOTIR-1730 shipped the HAPPY-PATH suite
// (`use-plan-change-conversation.test.tsx` — resume, a turn, narration, EMPTY,
// out-of-credits, retry, approve/discard) and this file adds only what that
// suite leaves unexecuted, which is what took the hook under the per-file gate:
//
//   * the APPEND leg failing (the turn never lands, so there is nothing to
//     submit) — distinct from the SUBMIT leg failing, which is covered;
//   * the in-flight REENTRANCY guards (`send`/`retry` while a run is open) —
//     a double-click must not open a second job on one thread;
//   * UNMOUNT mid-flight: the abort is swallowed, and no state write lands on a
//     dead component;
//   * `approve` with nothing selected, a non-typed approve failure, and
//     `dismissError`.

const { open, append, submit, stream, fetchReview, approve, decline } = vi.hoisted(() => ({
  open: vi.fn(),
  append: vi.fn(),
  submit: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  openPlanChangeSession: open,
  appendPlanChangeTurn: append,
  submitPlanChange: submit,
  // The anchored half (MOTIR-910) is unused by these project-thread edge cases,
  // but the module mock must still carry every export the hook imports.
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

import { usePlanChangeConversation, narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

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

const REVIEW: PlanReviewDto = planReview([
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
]);

const MATERIALIZED: PlanWithItemsDto = {
  id: 'plan-1',
  projectId: 'proj_1',
  status: 'approved',
  title: null,
  summary: null,
  sourceJobId: 'job-1',
  itemCount: 1,
  createdAt: '2026-07-27T09:00:00.000Z',
  plannedAt: '2026-07-27T09:01:00.000Z',
  decidedAt: '2026-07-27T09:05:00.000Z',
  decidedById: 'u1',
  items: [
    {
      id: 'pi_1',
      op: 'add',
      workItemId: 'wi_new',
      proposedFields: { title: 'Recurring' },
      patch: null,
      parentRef: null,
      blockedByRefs: [],
      baseRevision: null,
      createdAt: '2026-07-27T09:01:00.000Z',
    },
  ],
};

function okStream() {
  return vi.fn(async () => {});
}

/** The DOMException the fetch layer raises when a caller aborts. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A promise plus the handles to settle it from the test — for pinning a call
 *  in flight while another one is attempted. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  open.mockResolvedValue(session([]));
  append.mockImplementation(async (body: string) => session([body]));
  submit.mockResolvedValue({
    jobId: 'job-1',
    planId: 'plan-1',
    session: session(['Add recurring invoices.']),
  });
  stream.mockImplementation(okStream());
  fetchReview.mockResolvedValue(REVIEW);
  approve.mockResolvedValue(MATERIALIZED);
  decline.mockResolvedValue({ ...MATERIALIZED, status: 'declined', items: [] });
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

describe('usePlanChangeConversation — the APPEND leg fails', () => {
  it('does NOT submit when the turn could not be recorded', async () => {
    // The distinction that matters: the thread is the intent. If the turn never
    // landed, submitting would send the OLD accumulated intent and silently drop
    // what the user just typed — worse than failing.
    append.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(submit).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('leaves a PRIOR proposal in review when a later append fails', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.phase).toBe('review');

    append.mockRejectedValue(new PlanEditsClientError(500, null));
    await act(async () => {
      await result.current.send('Actually, make them smaller.');
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('releases the in-flight latch so the next send can proceed', async () => {
    // A failed append that left `abortRef` set would wedge the rail: every later
    // send would hit the reentrancy guard and silently do nothing.
    append.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('first');
    });
    await act(async () => {
      await result.current.send('second');
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('review');
  });
});

describe('usePlanChangeConversation — one run at a time', () => {
  it('ignores a second send while a run is in flight', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    append.mockReturnValueOnce(pending.promise);
    const { result } = await mounted();

    let first: Promise<void>;
    await act(async () => {
      first = result.current.send('Add recurring invoices.');
      // The double-click: fired before the first append settles.
      await result.current.send('Add recurring invoices.');
    });
    expect(append).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(session(['Add recurring invoices.']));
      await first!;
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('ignores a retry while a run is in flight', async () => {
    const pending = deferred<{ jobId: string; planId: string; session: PlanChangeSessionDto }>();
    submit.mockReturnValueOnce(pending.promise);
    const { result } = await mounted();

    let first: Promise<void>;
    await act(async () => {
      first = result.current.send('Add recurring invoices.');
      await result.current.retry();
    });
    expect(submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({
        jobId: 'job-1',
        planId: 'plan-1',
        session: session(['Add recurring invoices.']),
      });
      await first!;
    });
  });

  it('ignores a blank or whitespace-only turn', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('   \n  ');
    });
    expect(append).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });
});

describe('usePlanChangeConversation — an aborted call is not an error', () => {
  it('swallows the mount read’s abort rather than showing a failure', async () => {
    // Unmounting during the resume read aborts it; the user never sees a rail
    // that says "couldn't load" on a surface they already left.
    open.mockRejectedValue(abortError());
    const { result } = renderHook(() => usePlanChangeConversation());

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('loading');
  });

  it('shows a recoverable error for a REAL mount-read failure', async () => {
    open.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = renderHook(() => usePlanChangeConversation());

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
  });

  it('swallows an aborted RUN rather than flagging it as failed', async () => {
    submit.mockRejectedValue(abortError());
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.outOfCredits).toBe(false);
  });

  it('swallows an aborted APPEND rather than flagging it as failed', async () => {
    append.mockRejectedValue(abortError());
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('usePlanChangeConversation — unmounting mid-flight', () => {
  it('aborts the in-flight run and writes no state after unmount', async () => {
    const pending = deferred<{ jobId: string; planId: string; session: PlanChangeSessionDto }>();
    submit.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });

    const phaseAtUnmount = hook.result.current.state.phase;
    hook.unmount();

    // Settling AFTER unmount must be inert: no stream, no result fetch, and no
    // React "update on an unmounted component" write.
    await act(async () => {
      pending.resolve({
        jobId: 'job-1',
        planId: 'plan-1',
        session: session(['Add recurring invoices.']),
      });
      await run!;
    });

    expect(stream).not.toHaveBeenCalled();
    expect(fetchReview).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe(phaseAtUnmount);
  });

  it('drops the resume payload that arrives after unmount', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    open.mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => usePlanChangeConversation());

    hook.unmount();
    await act(async () => {
      pending.resolve(session(['a turn']));
      await pending.promise;
    });

    // Never left `loading`: the write was skipped, not applied to a dead tree.
    expect(hook.result.current.state.phase).toBe('loading');
    expect(hook.result.current.state.session).toBeNull();
  });

  it('drops an append failure that arrives after unmount', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    append.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.reject(new PlanEditsClientError(500, null));
      await run!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('drops a settled plan read that arrives after unmount', async () => {
    const pending = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.resolve(REVIEW);
      await run!;
    });

    expect(hook.result.current.state.review).toBeNull();
  });

  it('drops a stream failure and its progress frames after unmount', async () => {
    let emit: ((event: string, data: unknown) => void) | undefined;
    let fail: ((code: string | null) => void) | undefined;
    const pending = deferred<void>();
    stream.mockImplementationOnce(
      async (
        _jobId: string,
        _signal: AbortSignal,
        onError: (code: string | null) => void,
        _onDone: () => void,
        onFrame?: (event: string, data: unknown) => void,
      ) => {
        emit = onFrame;
        fail = onError;
        await pending.promise;
      },
    );
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      emit?.('drill', {});
      fail?.('FAILED');
      pending.resolve();
      await run!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.progress).toEqual({ kind: 'submitted' });
  });

  it('drops an approve result that arrives after unmount', async () => {
    const pending = deferred<{ created: string[]; updated: string[]; unchanged: string[] }>();
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    approve.mockReturnValueOnce(pending.promise);
    let approving: Promise<void>;
    await act(async () => {
      approving = hook.result.current.approve();
    });
    hook.unmount();

    await act(async () => {
      pending.resolve({ created: ['PAY-30'], updated: [], unchanged: [] });
      await approving!;
    });

    expect(hook.result.current.state.approved).toBeNull();
  });

  it('drops an approve FAILURE that arrives after unmount', async () => {
    const pending = deferred<never>();
    const hook = await mounted();
    await act(async () => {
      await hook.result.current.send('Add recurring invoices.');
    });

    approve.mockReturnValueOnce(pending.promise);
    let approving: Promise<void>;
    await act(async () => {
      approving = hook.result.current.approve();
    });
    hook.unmount();

    await act(async () => {
      pending.reject(new PlanEditsClientError(500, null));
      await approving!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
    expect(hook.result.current.state.phase).toBe('deciding');
  });

  it('drops an append SUCCESS that arrives after unmount', async () => {
    const pending = deferred<PlanChangeSessionDto>();
    append.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.resolve(session(['Add recurring invoices.']));
      await run!;
    });

    // The turn IS on the server; the dead rail just does not re-render for it,
    // and the run stops there rather than submitting into the void.
    expect(hook.result.current.state.session?.turns).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('drops a submit failure that arrives after unmount', async () => {
    const pending = deferred<never>();
    submit.mockReturnValueOnce(pending.promise);
    const hook = await mounted();

    let run: Promise<void>;
    await act(async () => {
      run = hook.result.current.send('Add recurring invoices.');
    });
    hook.unmount();

    await act(async () => {
      pending.reject(new PlanEditsClientError(500, null));
      await run!;
    });

    expect(hook.result.current.state.errorCode).toBeNull();
  });
});

describe('usePlanChangeConversation — a failed SUBMIT keeps the prior proposal', () => {
  it('stays in review when the submit leg fails after an earlier success', async () => {
    // The counterpart to the shipped STREAM-failure case: the run can also die
    // before the job exists. Either way the canvas must not lose the proposal
    // the user is still looking at.
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.phase).toBe('review');

    submit.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.errorCode).toBe('FAILED');
  });

  it('keeps a prior proposal when a retry is refused for credits', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    submit.mockRejectedValueOnce(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('completes a run whose stream signals done', async () => {
    // The shipped suite's stub never calls `onDone`; the real SSE does on a
    // clean close, and the hook must fall through to reading the run's plan.
    stream.mockImplementationOnce(
      async (
        _jobId: string,
        _signal: AbortSignal,
        _onError: (code: string | null) => void,
        onDone: () => void,
      ) => {
        onDone();
      },
    );
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(fetchReview).toHaveBeenCalledWith('plan-1', expect.anything());
    expect(result.current.state.phase).toBe('review');
  });
});

describe('usePlanChangeConversation — approve edges', () => {
  it('does nothing when there is no proposal to approve', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.approve();
    });
    expect(approve).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });

  it('reports an untyped approve failure as APPROVE_ERROR and stays in review', async () => {
    approve.mockRejectedValue(new Error('network down'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('APPROVE_ERROR');
    expect(result.current.state.phase).toBe('review');
    // Nothing was consumed — the proposal is still there to retry.
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('falls back to APPROVE_ERROR for a typed error with no code', async () => {
    approve.mockRejectedValue(new PlanRequestError(500, null));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('APPROVE_ERROR');
  });

  it('never puts a raw server code on screen — an unrecognized one reads as the generic failure', async () => {
    approve.mockRejectedValue(new PlanRequestError(400, 'PLAN_GRAMMAR_VIOLATION'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    // The two codes a reviewer can act on (`immutable` / `decided`) are named;
    // everything else falls to the recoverable line rather than leaking a code.
    expect(result.current.state.errorCode).toBe('APPROVE_ERROR');
  });

  it('reports a plan that vanished as already DECIDED, not as a failure to retry', async () => {
    approve.mockRejectedValue(new PlanRequestError(404, 'PLAN_NOT_FOUND'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('decided');
  });

  it('approves with NO onApproved callback wired', async () => {
    // The optional-callback arm: the hook is usable without the page-state
    // fan-out (a read-only host), and must not throw calling an absent callback.
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.approved).toEqual({
      created: ['wi_new'],
      updated: [],
      removed: [],
    });
    expect(result.current.state.phase).toBe('idle');
  });
});

describe('usePlanChangeConversation — dismissError', () => {
  it('clears both the error and the gated flag without touching the thread', async () => {
    submit.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    expect(result.current.state.outOfCredits).toBe(true);

    act(() => {
      result.current.dismissError();
    });

    expect(result.current.state.outOfCredits).toBe(false);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.session).not.toBeNull();
  });
});

describe('narrateFrame — the frames the augment job really emits', () => {
  it('ignores an unknown event and a frame with no data', () => {
    expect(narrateFrame('token', { text: 'hi' })).toBeNull();
    expect(narrateFrame('search', undefined)).toEqual({ kind: 'searching' });
  });

  it('narrates the retrieval frames the engine emits before it plans', () => {
    expect(narrateFrame('search', {})).toEqual({ kind: 'searching' });
    expect(narrateFrame('drill', {})).toEqual({ kind: 'drilling' });
  });

  it('defaults a non-numeric proposed count to zero rather than NaN', () => {
    expect(narrateFrame('planned', { proposed: 'lots' })).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('level_complete', {})).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('pass', { proposed: 4 })).toEqual({ kind: 'proposed', count: 4 });
  });

  it('narrates both validation frames as validating', () => {
    expect(narrateFrame('validated', {})).toEqual({ kind: 'validating' });
    expect(narrateFrame('validation_skipped', {})).toEqual({ kind: 'validating' });
  });
});
