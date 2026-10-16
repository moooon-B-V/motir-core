// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import {
  LiveSignalProvider,
  type LiveSignal,
  type LiveSignalListener,
  type LiveSignalSource,
  type LiveTopic,
} from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';

// THE GENERATING-PLAN POLL UNDER A PUSH SOURCE (Story MOTIR-8542 · Subtask
// MOTIR-8732).
//
// Under the shell's provider the plan topic is served by `plan` frames on the
// tab's one stream, and NO timer drives the poll. The source here is a fake the
// test fires by hand — its signals carry no `cadence` mark, exactly as the
// stream's do — so what is pinned is the hook's half of the move: a read per
// signal and none on a clock, a signal that lands mid-read is never lost, a
// `full` signal skips `?since=`, and a failed read still retries on its own.

const { fetchReview, fetchSince } = vi.hoisted(() => ({
  fetchReview: vi.fn(),
  fetchSince: vi.fn(),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview, fetchPlanReviewSince: fetchSince };
});

import { FAILING_AFTER, POLL_MS, useGeneratingPlanPoll } from '@/lib/hooks/useGeneratingPlanPoll';
import { planReview, planReviewItem } from '../helpers/planReview';

const A = planReviewItem({ planItemId: 'a', nodeId: 'a', title: 'A' });
const B = planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'B' });

function versioned(version: string, items = [A]): PlanReviewDto {
  return {
    ...planReview(items, { id: 'plan_1', status: 'generating', plannedAt: null }),
    reviewVersion: version,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A push source: signals only when the test fires one; `trigger` sends a forced one. */
function pushSource() {
  const listeners = new Map<string, Set<LiveSignalListener>>();
  const unsubscribes: string[] = [];
  let seq = 0;
  const key = (t: LiveTopic) => (t.kind === 'plan' ? t.planId : 'workbench');
  const emit = (topic: LiveTopic, extra: Partial<LiveSignal>) => {
    seq += 1;
    for (const l of [...(listeners.get(key(topic)) ?? [])]) l({ topic, seq, ...extra });
  };
  const source: LiveSignalSource = {
    subscribe(topic, onSignal) {
      const set = listeners.get(key(topic)) ?? new Set();
      set.add(onSignal);
      listeners.set(key(topic), set);
      return () => {
        unsubscribes.push(key(topic));
        set.delete(onSignal);
      };
    },
    trigger(topic) {
      emit(topic, { forced: true });
    },
    reconnecting: createLiveFlag(false),
  };
  return {
    source,
    unsubscribes,
    async fire(extra: Partial<LiveSignal> = {}) {
      await act(async () => {
        emit({ kind: 'plan', planId: 'plan_1' }, extra);
        await vi.advanceTimersByTimeAsync(0);
      });
    },
  };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(push: ReturnType<typeof pushSource>) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(LiveSignalProvider, { source: push.source }, children);
  return renderHook(() => useGeneratingPlanPoll('plan_1'), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useGeneratingPlanPoll under a push source', () => {
  it('reads on no clock: one first read, then nothing until a signal', async () => {
    fetchReview.mockResolvedValue(versioned('rv1.a'));
    const push = pushSource();
    const { unmount } = mount(push);
    await flush();
    expect(fetchReview).toHaveBeenCalledTimes(1);

    await flush(POLL_MS * 20);
    expect(fetchReview).toHaveBeenCalledTimes(1);
    expect(fetchSince).not.toHaveBeenCalled();
    unmount();
  });

  it('reads once per signal, asking `?since=` with the held version', async () => {
    fetchReview.mockResolvedValue(versioned('rv1.a'));
    fetchSince.mockResolvedValue({ unchanged: true, reviewVersion: 'rv1.a' });
    const push = pushSource();
    const { result, unmount } = mount(push);
    await flush();

    await push.fire();
    expect(fetchSince).toHaveBeenCalledTimes(1);
    expect(fetchSince).toHaveBeenCalledWith('plan_1', 'rv1.a', expect.any(AbortSignal));
    expect(result.current.version).toBe(1);

    await push.fire();
    expect(fetchSince).toHaveBeenCalledTimes(2);
    expect(fetchReview).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('a signal that lands mid-read is not lost: exactly one follow-up read when it settles', async () => {
    fetchReview.mockResolvedValueOnce(versioned('rv1.a'));
    const push = pushSource();
    const { result, unmount } = mount(push);
    await flush();

    const slow = deferred<unknown>();
    fetchSince.mockReturnValueOnce(slow.promise);
    fetchSince.mockResolvedValueOnce(versioned('rv1.b', [A, B]));
    await push.fire();
    expect(fetchSince).toHaveBeenCalledTimes(1);

    // Two frames while the read is out collapse into ONE dirty mark.
    await push.fire();
    await push.fire();
    expect(fetchSince).toHaveBeenCalledTimes(1);

    await act(async () => {
      slow.resolve({ unchanged: true, reviewVersion: 'rv1.a' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSince).toHaveBeenCalledTimes(2);
    expect(result.current.review?.items).toEqual([A, B]);

    await flush(POLL_MS * 4);
    expect(fetchSince).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a `full` signal reads without `?since=`, and so does its dirty follow-up', async () => {
    fetchReview.mockResolvedValue(versioned('rv1.a'));
    const push = pushSource();
    const { unmount } = mount(push);
    await flush();

    await push.fire({ full: true });
    expect(fetchReview).toHaveBeenCalledTimes(2);
    expect(fetchSince).not.toHaveBeenCalled();

    const slow = deferred<PlanReviewDto>();
    fetchReview.mockReturnValueOnce(slow.promise);
    await push.fire({ full: true });
    await push.fire({ full: true });
    expect(fetchReview).toHaveBeenCalledTimes(3);
    await act(async () => {
      slow.resolve(versioned('rv1.a'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchReview).toHaveBeenCalledTimes(4);
    expect(fetchSince).not.toHaveBeenCalled();
    unmount();
  });

  it('`refresh()` triggers a forced FULL read through the source, even over a read in flight', async () => {
    fetchReview.mockResolvedValueOnce(versioned('rv1.a'));
    const push = pushSource();
    const { result, unmount } = mount(push);
    await flush();

    fetchSince.mockReturnValueOnce(new Promise(() => {}));
    await push.fire();
    fetchReview.mockResolvedValueOnce(versioned('rv1.b', [A, B]));
    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchReview).toHaveBeenCalledTimes(2);
    expect(result.current.review?.items).toEqual([A, B]);
    unmount();
  });

  it('stops on a settled plan, unsubscribes, and ignores later signals', async () => {
    fetchReview.mockResolvedValueOnce(versioned('rv1.a'));
    const push = pushSource();
    const { unmount } = mount(push);
    await flush();

    fetchSince.mockResolvedValueOnce({ ...versioned('rv1.b'), status: 'ready' });
    await push.fire();
    await flush();
    expect(push.unsubscribes).toEqual(['plan_1']);

    await push.fire();
    expect(fetchSince).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('unmount aborts the read in flight and unsubscribes', async () => {
    fetchReview.mockResolvedValueOnce(versioned('rv1.a'));
    const push = pushSource();
    const { unmount } = mount(push);
    await flush();

    let signal: AbortSignal | undefined;
    fetchSince.mockImplementationOnce((_id: string, _v: string, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    await push.fire();
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(push.unsubscribes).toEqual(['plan_1']);
  });

  it('a failed read retries once after POLL_MS on its own, and reports `failing` after the threshold', async () => {
    fetchReview.mockRejectedValue(new Error('boom'));
    const push = pushSource();
    const { result, unmount } = mount(push);
    await flush();
    expect(fetchReview).toHaveBeenCalledTimes(1);

    // Each failure schedules exactly ONE retry, a POLL_MS later.
    for (let n = 2; n <= FAILING_AFTER; n++) {
      await flush(POLL_MS - 1);
      expect(fetchReview).toHaveBeenCalledTimes(n - 1);
      await flush(1);
      expect(fetchReview).toHaveBeenCalledTimes(n);
    }
    expect(result.current.failing).toBe(true);

    fetchReview.mockResolvedValue(versioned('rv1.a'));
    await flush(POLL_MS);
    expect(result.current.failing).toBe(false);
    await flush(POLL_MS * 4);
    expect(fetchReview).toHaveBeenCalledTimes(FAILING_AFTER + 1);
    unmount();
  });
});
