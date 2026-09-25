// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// THE generating-plan poll (Subtask MOTIR-6295) — the one poll the plan page,
// the onboarding reveal and the planning surface share. Driven with FAKE TIMERS
// against a mocked review read, so every tick is the test's to take: what is
// pinned is the poll's contract — a snapshot REPLACES, a stale response is
// dropped, the three stops, and `failing` on and off.

const { fetchReview } = vi.hoisted(() => ({ fetchReview: vi.fn() }));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview };
});

import { FAILING_AFTER, POLL_MS, useGeneratingPlanPoll } from '@/lib/hooks/useGeneratingPlanPoll';
import { planReview, planReviewItem } from '../helpers/planReview';

const A = planReviewItem({ planItemId: 'a', nodeId: 'a', title: 'A' });
const B = planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'B' });

function generating(items = [A], id = 'plan_1'): PlanReviewDto {
  return planReview(items, { id, status: 'generating', plannedAt: null });
}

/** A read the test resolves or rejects by hand, to control arrival order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let settled reads land, without moving the clock. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useGeneratingPlanPoll (MOTIR-6295)', () => {
  it('reads immediately, then once per interval', async () => {
    fetchReview.mockResolvedValue(generating());
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();

    expect(fetchReview).toHaveBeenCalledTimes(1);
    expect(fetchReview).toHaveBeenCalledWith('plan_1', expect.any(AbortSignal));
    expect(result.current.review?.items).toEqual([A]);
    expect(result.current.version).toBe(1);

    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(2);
    expect(result.current.version).toBe(2);
    unmount();
  });

  it('`immediate: false` waits a full interval before the first read', async () => {
    fetchReview.mockResolvedValue(generating());
    const { result, unmount } = renderHook(() =>
      useGeneratingPlanPoll('plan_1', { immediate: false }),
    );
    await flush();
    expect(fetchReview).not.toHaveBeenCalled();
    expect(result.current.review).toBeNull();

    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(1);
    expect(result.current.review?.items).toEqual([A]);
    unmount();
  });

  it('a snapshot REPLACES the items — [a, b] then [a] leaves [a]', async () => {
    fetchReview.mockResolvedValueOnce(generating([A, B])).mockResolvedValueOnce(generating([A]));
    const onSnapshot = vi.fn();
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1', { onSnapshot }));
    await flush();
    expect(result.current.review?.items).toEqual([A, B]);

    await tick();
    expect(result.current.review?.items).toEqual([A]);
    // The withdrawn proposal is gone from what the caller was handed, too.
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect((onSnapshot.mock.calls[1]![0] as PlanReviewDto).items).toEqual([A]);
    unmount();
  });

  it('drops a response issued BEFORE a later one and resolved after it', async () => {
    const early = deferred<PlanReviewDto>();
    const late = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(early.promise).mockReturnValueOnce(late.promise);
    const onSnapshot = vi.fn();
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1', { onSnapshot }));
    await flush();
    await tick(); // the second read is issued while the first is still out

    late.resolve(generating([A]));
    await flush();
    expect(result.current.review?.items).toEqual([A]);

    early.resolve(generating([A, B]));
    await flush();
    expect(result.current.review?.items).toEqual([A]);
    expect(result.current.version).toBe(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('STOPS after a response whose status is no longer `generating`', async () => {
    fetchReview
      .mockResolvedValueOnce(generating())
      .mockResolvedValueOnce(planReview([A, B], { status: 'planned' }));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(2);
    // The settled snapshot is still the one handed back.
    expect(result.current.review?.status).toBe('planned');

    await tick();
    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('STOPS (and aborts in flight) when `planId` changes, and starts on the new plan', async () => {
    const out = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(out.promise);
    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string | null }) => useGeneratingPlanPoll(id),
      { initialProps: { id: 'plan_1' as string | null } },
    );
    await flush();
    const signal = fetchReview.mock.calls[0]![1] as AbortSignal;

    fetchReview.mockResolvedValue(generating([B], 'plan_2'));
    rerender({ id: 'plan_2' });
    expect(signal.aborted).toBe(true);
    await flush();
    // The old plan's late response is not applied over the new plan's.
    out.resolve(generating([A]));
    await flush();
    expect(result.current.review?.id).toBe('plan_2');

    await tick();
    expect(fetchReview.mock.calls.map((c) => c[0])).toEqual(['plan_1', 'plan_2', 'plan_2']);

    // `null` is "nothing to watch": no review, and no further read.
    rerender({ id: null });
    expect(result.current.review).toBeNull();
    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('STOPS (and aborts in flight) on unmount', async () => {
    const out = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(out.promise);
    const { unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    const signal = fetchReview.mock.calls[0]![1] as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    await tick();
    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(1);
  });

  it('`failing` after 3 consecutive failures, off on the next success — the last snapshot kept', async () => {
    fetchReview
      .mockResolvedValueOnce(generating([A, B]))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(generating([A]));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    expect(result.current.failing).toBe(false);

    for (let i = 1; i < FAILING_AFTER; i++) {
      await tick();
      expect(result.current.failing).toBe(false);
      expect(result.current.review?.items).toEqual([A, B]);
    }
    await tick();
    expect(result.current.failing).toBe(true);
    expect(result.current.review?.items).toEqual([A, B]);

    await tick();
    expect(result.current.failing).toBe(false);
    expect(result.current.review?.items).toEqual([A]);
    unmount();
  });

  it('an aborted read keeps the last snapshot and the next tick retries', async () => {
    fetchReview
      .mockResolvedValueOnce(generating([A, B]))
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockResolvedValueOnce(generating([A]));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    await tick();
    expect(result.current.review?.items).toEqual([A, B]);
    await tick();
    expect(result.current.review?.items).toEqual([A]);
    unmount();
  });

  it('a failure older than an applied success is not counted', async () => {
    const early = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(early.promise).mockResolvedValue(generating([A]));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    await tick(); // read 2 succeeds while read 1 is still out
    early.reject(new Error('network'));
    await flush();
    await tick();
    await tick();
    // 1 stale failure ignored, then only successes: never failing.
    expect(result.current.failing).toBe(false);
    unmount();
  });

  it('`refresh` reads out of cadence, and is a no-op while nothing is polled', async () => {
    fetchReview.mockResolvedValue(generating());
    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string | null }) => useGeneratingPlanPoll(id),
      { initialProps: { id: null as string | null } },
    );
    act(() => result.current.refresh());
    await flush();
    expect(fetchReview).not.toHaveBeenCalled();

    rerender({ id: 'plan_1' });
    await flush();
    act(() => result.current.refresh());
    await flush();
    expect(fetchReview).toHaveBeenCalledTimes(2);
    expect(result.current.version).toBe(2);
    unmount();
  });
});
