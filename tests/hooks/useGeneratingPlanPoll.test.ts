// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// THE generating-plan poll (Subtask MOTIR-6295) — the one poll the plan page,
// the onboarding reveal and the planning surface share. Driven with FAKE TIMERS
// against a mocked review read, so every tick is the test's to take: what is
// pinned is the poll's contract — a snapshot REPLACES, a stale response is
// dropped, the three stops, and `failing` on and off.

const { fetchReview, fetchSince } = vi.hoisted(() => ({
  fetchReview: vi.fn(),
  fetchSince: vi.fn(),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview, fetchPlanReviewSince: fetchSince };
});

import {
  FAILING_AFTER,
  FULL_READ_EVERY,
  POLL_MS,
  STALL_MS,
  useGeneratingPlanPoll,
} from '@/lib/hooks/useGeneratingPlanPoll';
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
    // The second read is issued while the first is still out. An interval tick no longer does that
    // (MOTIR-8102); an explicit `refresh()` still can, which is the overlap the stale guard exists for.
    act(() => result.current.refresh());
    await flush();

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

  // MOTIR-8102 — the interval used to fire a new read every POLL_MS whether or not the previous
  // one had landed, so a read slower than the interval piled up behind itself. REPRODUCTION: with
  // the first read held open, three more intervals pass and the poll must not have read again.
  it('does NOT start a new read while the previous one is still in flight (MOTIR-8102)', async () => {
    const slow = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(slow.promise).mockResolvedValue(generating([A]));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    expect(fetchReview).toHaveBeenCalledTimes(1);

    await tick();
    await tick();
    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(1);

    // The held read lands: the poll carries on at its normal cadence from there.
    slow.resolve(generating([A, B]));
    await flush();
    expect(result.current.review?.items).toEqual([A, B]);
    await tick();
    expect(fetchReview).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('abandons a read that stays out past STALL_MS, counts it, and reads again (MOTIR-8102)', async () => {
    const hung = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(hung.promise).mockResolvedValue(generating([A]));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    const signal = fetchReview.mock.calls[0]![1] as AbortSignal;

    // Just short of the bound the hung read is still out, so nothing is issued behind it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_MS - POLL_MS);
    });
    expect(fetchReview).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);

    // The first tick at or past the bound abandons it and reads again.
    await tick();
    expect(signal.aborted).toBe(true);
    expect(fetchReview).toHaveBeenCalledTimes(2);
    expect(result.current.review?.items).toEqual([A]);
    unmount();
  });

  it('an explicit `refresh()` still reads over one in flight (MOTIR-8102)', async () => {
    const slow = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(slow.promise).mockResolvedValue(generating([A]));
    const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
    await flush();
    expect(fetchReview).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await flush();
    expect(fetchReview).toHaveBeenCalledTimes(2);
    expect(result.current.review?.items).toEqual([A]);
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
    act(() => result.current.refresh()); // read 2 succeeds while read 1 is still out (a tick would wait: MOTIR-8102)
    await flush();
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

  describe('an unchanged plan is answered in a few bytes (MOTIR-8127)', () => {
    const versioned = (version: string, items = [A]): PlanReviewDto => ({
      ...generating(items),
      reviewVersion: version,
    });

    it('asks "changed since?" with the held version, and an unchanged answer keeps everything', async () => {
      fetchReview.mockResolvedValue(versioned('rv1.a'));
      fetchSince.mockResolvedValue({ unchanged: true, reviewVersion: 'rv1.a' });
      const onSnapshot = vi.fn();
      const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1', { onSnapshot }));
      await flush();

      // The first read is always FULL — there is no version to send yet.
      expect(fetchReview).toHaveBeenCalledTimes(1);
      expect(fetchSince).not.toHaveBeenCalled();
      expect(result.current.version).toBe(1);
      const held = result.current.review;

      await tick();
      expect(fetchSince).toHaveBeenCalledWith('plan_1', 'rv1.a', expect.any(AbortSignal));
      expect(fetchReview).toHaveBeenCalledTimes(1);
      // Nothing moved: the same snapshot object, no version bump, no onSnapshot.
      expect(result.current.review).toBe(held);
      expect(result.current.version).toBe(1);
      expect(onSnapshot).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('a changed answer replaces the snapshot and the NEXT read sends the new version', async () => {
      fetchReview.mockResolvedValue(versioned('rv1.a'));
      fetchSince.mockResolvedValueOnce(versioned('rv1.b', [A, B]));
      fetchSince.mockResolvedValue({ unchanged: true, reviewVersion: 'rv1.b' });
      const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
      await flush();

      await tick();
      expect(result.current.review?.items).toEqual([A, B]);
      expect(result.current.version).toBe(2);

      await tick();
      expect(fetchSince).toHaveBeenLastCalledWith('plan_1', 'rv1.b', expect.any(AbortSignal));
      expect(result.current.version).toBe(2);
      unmount();
    });

    it('every FULL_READ_EVERYth poll is a full read, whatever the version says', async () => {
      fetchReview.mockResolvedValue(versioned('rv1.a'));
      fetchSince.mockResolvedValue({ unchanged: true, reviewVersion: 'rv1.a' });
      const { unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
      await flush();

      // One full read, then FULL_READ_EVERY - 1 conditional ones…
      for (let i = 0; i < FULL_READ_EVERY - 1; i += 1) await tick();
      expect(fetchSince).toHaveBeenCalledTimes(FULL_READ_EVERY - 1);
      expect(fetchReview).toHaveBeenCalledTimes(1);

      // …then the backstop: a full read that catches what the version cannot see.
      await tick();
      expect(fetchReview).toHaveBeenCalledTimes(2);
      expect(fetchSince).toHaveBeenCalledTimes(FULL_READ_EVERY - 1);
      unmount();
    });

    it('a forced `refresh()` is always a full read', async () => {
      fetchReview.mockResolvedValue(versioned('rv1.a'));
      fetchSince.mockResolvedValue({ unchanged: true, reviewVersion: 'rv1.a' });
      const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
      await flush();

      act(() => result.current.refresh());
      await flush();
      expect(fetchReview).toHaveBeenCalledTimes(2);
      expect(fetchSince).not.toHaveBeenCalled();
      unmount();
    });

    it('a review that carries no version is never read conditionally', async () => {
      fetchReview.mockResolvedValue(generating());
      const { unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
      await flush();
      await tick();
      await tick();

      expect(fetchSince).not.toHaveBeenCalled();
      expect(fetchReview).toHaveBeenCalledTimes(3);
      unmount();
    });

    it('an unchanged answer counts as a success: `failing` clears', async () => {
      fetchReview.mockResolvedValueOnce(versioned('rv1.a'));
      fetchSince.mockRejectedValueOnce(new Error('x'));
      fetchSince.mockRejectedValueOnce(new Error('x'));
      fetchSince.mockRejectedValueOnce(new Error('x'));
      fetchSince.mockResolvedValue({ unchanged: true, reviewVersion: 'rv1.a' });
      const { result, unmount } = renderHook(() => useGeneratingPlanPoll('plan_1'));
      await flush();
      for (let i = 0; i < FAILING_AFTER; i += 1) await tick();
      expect(result.current.failing).toBe(true);

      await tick();
      expect(result.current.failing).toBe(false);
      unmount();
    });
  });
});
