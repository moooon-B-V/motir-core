'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPlanReview, fetchPlanReviewSince } from '@/lib/planning/planReviewClient';
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
// ⚠️ SNAPSHOT SEMANTICS. `PlanItem` carries no `updatedAt`, and the plan's
// `lastActivityAt` (MOTIR-7822) says only WHEN something last happened, not WHAT —
// so there is no delta to merge, and each response REPLACES the review whole
// (its `lastActivityAt` and `inFlightSteps` included). A proposal withdrawn
// between two ticks disappears on the next one and cannot come back from a
// cache. Responses are applied in ISSUE order: a monotonic sequence drops any
// response older than the last one applied, so a slow early read can never
// overwrite a later snapshot. A failed or aborted tick keeps the last snapshot
// and simply retries on the next.
//
// ⚠️ NO READ STARTS BEHIND ANOTHER (MOTIR-8102). The interval is a cadence, not
// a promise: a tick that finds a read still out does NOT issue a second one. The
// review read is the heaviest the planning surface makes (the whole plan, every
// proposal's body, the narration window), so on a long plan it can outlast
// {@link POLL_MS}; issuing a fresh read every interval anyway queued a second,
// then a third, each as slow as the first, and the page slowed itself down. A read
// still out after {@link STALL_MS} is a stalled one, not a slow one: it is aborted
// (and counted as a failure, so `failing` reports it) and the next tick reads
// again, so one hung request can never freeze the poll. `refresh()` is the
// deliberate exception — an explicit nudge reads NOW even over a read in flight;
// the sequence guard above still drops whichever answer is older.
//
// ⚠️ AN UNCHANGED PLAN IS ANSWERED IN A FEW BYTES (MOTIR-8127). Every full response carries the
// plan's `reviewVersion`; the next tick sends it back as `?since=`, and while nothing the review
// shows has moved the server answers `{ unchanged: true }` instead of re-reading and re-sending the
// whole plan. An unchanged answer keeps the snapshot (the clock reading stays right: the progress
// line advances `observedAt` by how long the client has held it) and does NOT fire `onSnapshot` or
// bump `version`. Two reads are always FULL: a forced `refresh()`, and every
// {@link FULL_READ_EVERY}th poll — the version covers what the plan's own tables hold, and not a
// committed card a `modify`/`remove` proposal points at being renamed or moved, so that backstop
// bounds how long the snapshot can disagree with it.
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

/** A read still out after this long is abandoned so the poll can read again (MOTIR-8102). */
export const STALL_MS = 15_000;

/** Every Nth poll is a FULL read even when the version says unchanged (MOTIR-8127). */
export const FULL_READ_EVERY = 8;

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
  const tickRef = useRef<((force?: boolean) => void) | null>(null);

  useEffect(() => {
    if (!planId) return;
    let stopped = false;
    let issued = 0;
    let applied = 0;
    let failures = 0;
    // The version of the last FULL snapshot applied, and how many unchanged answers followed it.
    let heldVersion: string | null = null;
    let unchangedRun = 0;
    // Each read's controller, with when it started: a tick skips while one is out.
    const inFlight = new Map<AbortController, number>();

    const stop = () => {
      stopped = true;
      clearInterval(handle);
      for (const ctrl of inFlight.keys()) ctrl.abort();
      inFlight.clear();
      if (tickRef.current === tick) tickRef.current = null;
    };

    // `force` is an explicit `refresh()`: it reads even over one in flight.
    const tick = (force = false) => {
      if (stopped) return;
      if (!force) {
        // A read out past the stall bound is abandoned, so a hung request cannot freeze the cadence.
        const now = Date.now();
        for (const [out, startedAt] of inFlight) {
          if (now - startedAt >= STALL_MS) {
            out.abort();
            inFlight.delete(out);
          }
        }
        // Still a read out: do not start another behind it (MOTIR-8102).
        if (inFlight.size > 0) return;
      }
      const seq = ++issued;
      const ctrl = new AbortController();
      inFlight.set(ctrl, Date.now());
      // A forced read, a first read and the periodic backstop are FULL; the rest ask "changed since?".
      const since =
        !force && heldVersion && unchangedRun < FULL_READ_EVERY - 1 ? heldVersion : null;
      void (
        since
          ? fetchPlanReviewSince(planId, since, ctrl.signal)
          : fetchPlanReview(planId, ctrl.signal)
      )
        .then((answer) => {
          // Dropped: the poll stopped, or a LATER read has already been applied.
          if (stopped || seq <= applied) return;
          applied = seq;
          failures = 0;
          setFailingFor(null);
          if ('unchanged' in answer) {
            // Nothing moved: the snapshot, `version` and `onSnapshot` all stand.
            unchangedRun += 1;
            return;
          }
          const review = answer;
          heldVersion = review.reviewVersion ?? null;
          unchangedRun = 0;
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
    const handle = setInterval(() => tick(), POLL_MS);
    if (immediate) tick();
    return stop;
  }, [planId, immediate]);

  const refresh = useCallback(() => {
    tickRef.current?.(true);
  }, []);

  const current = planId && snapshot && snapshot.planId === planId ? snapshot.review : null;
  return {
    review: current,
    version,
    failing: !!planId && failingFor === planId,
    refresh,
  };
}
