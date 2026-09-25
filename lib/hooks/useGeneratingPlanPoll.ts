'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// THE generating-plan poll (Subtask MOTIR-6295) — the ONE place a `generating`
// Plan is watched while it is being written. Lifted out of the two effects that
// each carried a private copy of it: the plan page's live poll (`PlanDetail`) and
// the onboarding reveal (`usePlanGeneration`); the planning surface
// (`usePlanChangeConversation`) is its third caller.
//
// ⚠️ THE TRANSPORT IS THE REVIEW READ (`GET /api/plans/[id]` via
// `fetchPlanReview`), never a job stream: it is the only live read an
// MCP-authored plan has, and it is the same read every review surface settles
// through, so what the poll shows and what the gate later confirms cannot be two
// different shapes.
//
// ⚠️ SNAPSHOT SEMANTICS. `Plan` / `PlanItem` carry no `updatedAt`, so there is no
// delta to merge — each response REPLACES the review whole. A proposal withdrawn
// between two ticks disappears on the next one and cannot come back from a
// cache. Responses are applied in ISSUE order: a monotonic sequence drops any
// response older than the last one applied, so a slow early read can never
// overwrite a later snapshot. A failed or aborted tick keeps the last snapshot
// and simply retries on the next.
//
// It stops — and aborts what is in flight — when a snapshot's status is no
// longer `generating`, when `planId` changes, or on unmount. A `null` planId is
// "nothing to watch".
//
// It draws NOTHING. Callers decide what a snapshot means: `onSnapshot` fires
// with every applied response, in the same tick it lands, for callers whose own
// state must move with it (the plan page's `review`, the reveal's `items`).

/** The generating-plan poll cadence. */
export const POLL_MS = 2500;

/** Consecutive failed reads after which the poll reports `failing`. */
export const FAILING_AFTER = 3;

export interface GeneratingPlanPollOptions {
  /** Read once immediately, before the first interval (default `true`). The plan
   *  page seeds from the server read, so it waits a full interval, as it always has. */
  immediate?: boolean;
  /** Called with every APPLIED snapshot (a stale or failed read never reaches it). */
  onSnapshot?: (review: PlanReviewDto) => void;
}

export interface GeneratingPlanPoll {
  /** The latest applied snapshot of the plan being polled, or `null` before the
   *  first one (and whenever `planId` is `null`). */
  review: PlanReviewDto | null;
  /** Bumped on every applied snapshot. */
  version: number;
  /** `true` after {@link FAILING_AFTER} consecutive failed reads; `false` again on
   *  the next success. The last good snapshot is kept throughout. */
  failing: boolean;
  /** Read NOW, out of cadence (the reveal's stream nudge). A no-op while nothing
   *  is being polled. */
  refresh: () => void;
}

interface Snapshot {
  planId: string;
  review: PlanReviewDto;
}

export function useGeneratingPlanPoll(
  planId: string | null,
  opts: GeneratingPlanPollOptions = {},
): GeneratingPlanPoll {
  const immediate = opts.immediate ?? true;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [version, setVersion] = useState(0);
  // Keyed by plan, so a `planId` change reads as "not failing" without a reset.
  const [failingFor, setFailingFor] = useState<string | null>(null);

  // The latest callback, without re-starting the poll when a caller re-renders.
  const onSnapshotRef = useRef(opts.onSnapshot);
  useEffect(() => {
    onSnapshotRef.current = opts.onSnapshot;
  });
  const tickRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!planId) return;
    let stopped = false;
    let issued = 0;
    let applied = 0;
    let failures = 0;
    const inFlight = new Set<AbortController>();

    const stop = () => {
      stopped = true;
      clearInterval(handle);
      for (const ctrl of inFlight) ctrl.abort();
      inFlight.clear();
      if (tickRef.current === tick) tickRef.current = null;
    };

    const tick = () => {
      if (stopped) return;
      const seq = ++issued;
      const ctrl = new AbortController();
      inFlight.add(ctrl);
      void fetchPlanReview(planId, ctrl.signal)
        .then((review) => {
          // Dropped: the poll stopped, or a LATER read has already been applied.
          if (stopped || seq <= applied) return;
          applied = seq;
          failures = 0;
          setFailingFor(null);
          setSnapshot({ planId, review });
          setVersion((v) => v + 1);
          onSnapshotRef.current?.(review);
          if (review.status !== 'generating') stop();
        })
        .catch(() => {
          // Best-effort — the last snapshot stands and the next tick retries. A
          // failure older than an applied success says nothing about now.
          if (stopped || seq <= applied) return;
          failures += 1;
          if (failures >= FAILING_AFTER) setFailingFor(planId);
        })
        .finally(() => {
          inFlight.delete(ctrl);
        });
    };

    tickRef.current = tick;
    const handle = setInterval(tick, POLL_MS);
    if (immediate) tick();
    return stop;
  }, [planId, immediate]);

  const refresh = useCallback(() => {
    tickRef.current?.();
  }, []);

  const current = planId && snapshot && snapshot.planId === planId ? snapshot.review : null;
  return {
    review: current,
    version,
    failing: !!planId && failingFor === planId,
    refresh,
  };
}
