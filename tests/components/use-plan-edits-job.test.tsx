// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

// The ITEM-SCOPED expand / re-plan loop (the `/items` row-action dock), moved off
// the dead `planDelta` onto the run's PLAN by MOTIR-1747: submit → stream → read
// the proposals from the Plan → approve (materialize) or discard (decline).
//
// The regression this file pins is the whole bug: with the delta read, a settled
// run ALWAYS reported "nothing was proposed" — motir-ai's handlers return
// `planDelta: { operations: [] }` and write their real output as PlanItems — so
// the dock could never reach review and its Approve could never fire.

const { submitExpand, submitReplan, streamExpand, streamReplan, fetchReview, approve, decline } =
  vi.hoisted(() => ({
    submitExpand: vi.fn(),
    submitReplan: vi.fn(),
    streamExpand: vi.fn(),
    streamReplan: vi.fn(),
    fetchReview: vi.fn(),
    approve: vi.fn(),
    decline: vi.fn(),
  }));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    submitExpandJob: submitExpand,
    submitReplanJob: submitReplan,
    streamExpandJob: streamExpand,
    streamReplanJob: streamReplan,
  };
});

// The PLANS API — the same client `/plans/[id]` and the conversational rail call.
// There is no second write path to mock.
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

import { usePlanEditsJob } from '@/lib/hooks/usePlanEditsJob';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

/** A stream that just completes — the frames themselves are the SSE's business. */
function settles() {
  return async (
    _jobId: string,
    _signal: AbortSignal,
    _onError: (code: string | null) => void,
    onDone: () => void,
  ) => {
    onDone();
  };
}

function fails(code: string | null) {
  return async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
    onError(code);
  };
}

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('usePlanEditsJob — the run settles on its PLAN', () => {
  it('reaches review with the run’s proposals, though the job’s delta is empty', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_1', planId: 'plan_1' });
    streamExpand.mockImplementation(settles());
    fetchReview.mockResolvedValue(
      planReview([
        planReviewItem({ planItemId: 'pi_1', title: 'Session cookies', kind: 'subtask' }),
        planReviewItem({ planItemId: 'pi_2', op: 'remove', title: 'Stale spike' }),
      ]),
    );

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });

    await waitFor(() => expect(result.current.state.phase).toBe('review'));
    expect(result.current.state.planId).toBe('plan_1');
    expect(result.current.state.review?.items.map((i) => i.title)).toEqual([
      'Session cookies',
      'Stale spike',
    ]);
    // The run's proposals are read from the PLAN — nothing consults the job.
    expect(fetchReview).toHaveBeenCalledWith('plan_1', expect.anything());
  });

  it('approves through the plans approve route and reports what landed', async () => {
    submitReplan.mockResolvedValue({ jobId: 'job_2', planId: 'plan_2' });
    streamReplan.mockImplementation(settles());
    fetchReview.mockResolvedValue(planReview([planReviewItem()]));
    approve.mockResolvedValue({
      items: [
        { id: 'pi_1', op: 'add', workItemId: 'wi_1' },
        { id: 'pi_2', op: 'modify', workItemId: 'wi_2' },
      ],
    } as unknown as PlanWithItemsDto);

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('replan', { itemKey: 'MOTIR-9' });
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    await act(async () => {
      await result.current.approve();
    });

    expect(approve).toHaveBeenCalledWith('plan_2');
    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.approved).toEqual({
      created: ['wi_1'],
      updated: ['wi_2'],
      removed: [],
    });
    // Decided: the confirm target is released rather than lingering as a stale one.
    expect(result.current.state.planId).toBeNull();
  });

  it('DISCARD declines the plan — a waved-away run is decided, not orphaned', async () => {
    // The orphan this prevents: a proposal abandoned client-side sits at
    // `planned` forever, which the auto-plan pause (MOTIR-1740) reads as a
    // proposal still awaiting review.
    submitExpand.mockResolvedValue({ jobId: 'job_3', planId: 'plan_3' });
    streamExpand.mockImplementation(settles());
    fetchReview.mockResolvedValue(planReview([planReviewItem()]));
    decline.mockResolvedValue({ id: 'plan_3', status: 'declined' });

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    await act(async () => {
      await result.current.discard();
    });

    expect(decline).toHaveBeenCalledWith('plan_3');
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.review).toBeNull();
  });

  it('keeps a proposal decidable when the decline itself fails', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_4', planId: 'plan_4' });
    streamExpand.mockImplementation(settles());
    fetchReview.mockResolvedValue(planReview([planReviewItem()]));
    decline.mockRejectedValue(new PlanRequestError(500, null));

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    await act(async () => {
      await result.current.discard();
    });

    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.errorCode).toBe('discard');
  });

  it('discarding a run that never reached review declines NOTHING', async () => {
    // A plan is only decidable once it is `planned`; cancelling mid-generation
    // must not POST a decline the server would reject.
    submitExpand.mockResolvedValue({ jobId: 'job_5', planId: 'plan_5' });
    streamExpand.mockImplementation(
      async () =>
        new Promise<void>(() => {
          /* never settles — the user cancels first */
        }),
    );

    const { result } = renderHook(() => usePlanEditsJob());
    act(() => {
      void result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });
    await waitFor(() => expect(result.current.state.phase).toBe('running'));

    await act(async () => {
      await result.current.discard();
    });

    expect(decline).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('idle');
  });

  it('reports a genuinely empty run as EMPTY, not as a review of nothing', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_6', planId: 'plan_6' });
    streamExpand.mockImplementation(settles());
    fetchReview.mockResolvedValue(planReview([]));

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });

    await waitFor(() => expect(result.current.state.errorCode).toBe('EMPTY'));
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.review).toBeNull();
  });

  it('surfaces the metered-AI refusal as its own state', async () => {
    submitExpand.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });

    expect(result.current.state.errorCode).toBe('out_of_credits');
    expect(fetchReview).not.toHaveBeenCalled();
  });

  it('does not read a plan for a run whose stream reported failure', async () => {
    submitExpand.mockResolvedValue({ jobId: 'job_7', planId: 'plan_7' });
    streamExpand.mockImplementation(fails('ENGINE_DOWN'));

    const { result } = renderHook(() => usePlanEditsJob());
    await act(async () => {
      await result.current.startJob('expand', { itemKey: 'MOTIR-7' });
    });

    expect(result.current.state.errorCode).toBe('ENGINE_DOWN');
    expect(fetchReview).not.toHaveBeenCalled();
  });
});
