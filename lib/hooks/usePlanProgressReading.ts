'use client';

import { useEffect, useState } from 'react';
import {
  readPlanProgress,
  serverNow,
  type PlanProgressReading,
  type PlanProgressSnapshot,
  type PlanProgressState,
  type PlanProgressStep,
} from '@/lib/plans/planProgress';

// THE ONE CLOCK behind a generating plan's progress (Story MOTIR-7820 · Subtask
// MOTIR-7829; design `design/ai-planning/design-notes.md` Part XXV §25.4, §25.10).
//
// The progress line AND the canvas cues read their live steps from this hook, so
// a step that goes quiet between two polls stops being named by the words and by
// the canvas at the same instant. It DECIDES NOTHING: every reading is
// `readPlanProgress(snapshot, serverNow(…))`, the derivation's own verdict. It
// never compares a timestamp to the threshold, never filters a step and never
// chooses a phrase — that is `lib/plans/planProgress.ts`'s job, and a second copy
// here is how the tab row and the plan surface would come to disagree.
//
// ── The clock ───────────────────────────────────────────────────────────────
// A snapshot is RECEIVED when its identity changes (each applied poll is a new
// object; the SSR-seeded first one counts as received at mount). From then on
// the reading advances once a second (§25.4's tick) by how long the client has
// HELD that snapshot — `serverNow(observedAt, receivedAtMs, clientNowMs)`, both
// instants on the client's own clock, so its skew cancels. The effect below is
// the only place `Date.now()` is read.
//
// ── The dropped read (§25.10) ───────────────────────────────────────────────
// While `failing`, the reading's `state` and `liveSteps` HOLD at what the last
// successful snapshot said when the read started failing; elapsed time and time
// since activity keep ticking (they are facts about that snapshot). A reader
// whose own connection dropped cannot tell a quiet planner from a quiet network,
// so a stalled label there would be a claim about the planner nobody measured —
// "stalled is never computed client-side: only a read can declare it".

/** The reading, with the server-corrected instant it was taken at — what a
 *  surface formats clock times and step durations against. */
export interface PlanProgressClockReading extends PlanProgressReading {
  /** The server-time instant (ms) this reading is for. */
  serverNowMs: number;
}

/** The progress line's tick cadence (design §25.4: once a second). */
export const PLAN_PROGRESS_TICK_MS = 1000;

interface Clock {
  snapshot: PlanProgressSnapshot;
  receivedAtMs: number;
  clientNowMs: number;
}

interface Hold {
  state: PlanProgressState;
  liveSteps: PlanProgressStep[];
}

export function usePlanProgressReading(
  progress: PlanProgressSnapshot | null,
  opts: { failing?: boolean } = {},
): PlanProgressClockReading | null {
  const failing = opts.failing ?? false;
  const [clock, setClock] = useState<Clock | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);

  useEffect(() => {
    if (!progress) return;
    // Received NOW. Until the first tick lands, the render below reads the
    // snapshot at its own `observedAt` (nothing held yet), which is the same
    // instant — so no state is set here.
    const receivedAtMs = Date.now();
    const handle = setInterval(() => {
      setClock({ snapshot: progress, receivedAtMs, clientNowMs: Date.now() });
    }, PLAN_PROGRESS_TICK_MS);
    return () => clearInterval(handle);
  }, [progress]);

  let reading: PlanProgressClockReading | null = null;
  if (progress) {
    // A snapshot this render has not stamped yet IS the instant it was received:
    // nothing has been held, so the reading is the snapshot at its own `observedAt`.
    const current = clock && clock.snapshot === progress ? clock : null;
    const nowMs = current
      ? serverNow(progress.observedAt, current.receivedAtMs, current.clientNowMs)
      : serverNow(progress.observedAt, 0, 0);
    reading = { ...readPlanProgress(progress, nowMs), serverNowMs: nowMs };
  }

  // The hold is taken the render the read starts failing, and dropped the render
  // it recovers (or the snapshot goes away) — the derived-state pattern, so the
  // held value is the one that was ON SCREEN when the reads stopped landing.
  const shouldHold = failing && reading !== null;
  if (shouldHold && hold === null && reading) {
    setHold({ state: reading.state, liveSteps: reading.liveSteps });
  } else if (!shouldHold && hold !== null) {
    setHold(null);
  }

  if (reading && failing) {
    const held = hold ?? { state: reading.state, liveSteps: reading.liveSteps };
    return { ...reading, state: held.state, liveSteps: held.liveSteps };
  }
  return reading;
}
