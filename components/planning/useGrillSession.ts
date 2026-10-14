'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SharpenAction } from '@/lib/ai/types';
import type { SharpenDoorResult, SharpenSessionDto } from '@/lib/dto/sharpen';
import {
  getOpenSharpen,
  openSharpen,
  resubmitSharpen,
  settleSharpen,
  sharpenAct,
} from '@/lib/planning/sharpenClient';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

// THE ROUTE THE "GRILL ME" MODE SWITCHES (Task MOTIR-1101 · Subtask MOTIR-8447).
//
// With Grill me on, the conversation phase's questions come from a Sharpen
// session over the RUN'S OWN plan (the `generating` plan the run is writing —
// MOTIR-8445 made it a target the door admits), driven through the door's own
// browser client (`lib/planning/sharpenClient.ts`). The hook is the only thing
// that calls that client for the rail.
//
// ⚠️ TURNING IT ON STARTS NOTHING. The switch arms the mode at the number of
// person turns the conversation has; a session is opened only once a person turn
// arrives AFTER that (design G2: "Your next message starts the grilling") and the
// run has a plan to grill over. A render, a plan generation or a re-entered phase
// opens nothing. The one read it makes on its own is the GET of an already-open
// session for that plan, so a reload or a re-entered phase resumes where the
// person was without sending anything.
//
// One act at a time: while a turn's job is in flight every act is refused here
// (the door refuses a second one too — SHARPEN_TURN_IN_FLIGHT), except Stop,
// which is always reachable.

const SETTLE_POLL_MS = 1000;

export type GrillError = 'failed' | 'refused' | 'outOfCredits' | null;

export interface GrillSession {
  /** The session the rail draws, or null before one is opened. */
  session: SharpenSessionDto | null;
  /** A turn's job (or the open itself) is in flight. */
  pending: boolean;
  error: GrillError;
  /** Answer the pending question — one act. */
  act: (
    action: Exclude<SharpenAction, 'start' | 'stop'>,
    opts?: { readingId?: string; text?: string },
  ) => void;
  stop: () => void;
  /** Re-run the turn whose job failed (Try again). */
  retry: () => void;
}

interface Args {
  /** The person's Grill me choice. */
  on: boolean;
  /** The run's own plan; null until the run has one. */
  planId: string | null;
  /** The run is in its conversation phase (the control is rendered). */
  active: boolean;
  /** How many person turns the plan-change conversation has. */
  personTurns: number;
}

function codeOf(err: unknown): string | null {
  return err instanceof PlanEditsClientError ? (err.code ?? null) : null;
}

function isOutOfCredits(err: unknown): boolean {
  return (
    err instanceof PlanEditsClientError && (err.status === 402 || err.code === 'out_of_credits')
  );
}

/** The person turn a failed planner turn answers — the one Try again re-runs. */
function failedPersonTurnId(session: SharpenSessionDto): string | null {
  const turns = session.turns;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]!.failed) {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (turns[j]!.role === 'person') return turns[j]!.id;
      }
      return null;
    }
  }
  return null;
}

export function useGrillSession({ on, planId, active, personTurns }: Args): GrillSession {
  const [session, setSession] = useState<SharpenSessionDto | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<GrillError>(null);

  // THE ARM: the person-turn count at the moment the mode was turned on (or the
  // mount found it on). A session opens only for a person turn past it.
  const armedAtRef = useRef<number | null>(on ? personTurns : null);
  const prevOnRef = useRef(on);
  // The person-turn count a round was opened at — a later round needs a later turn.
  const roundAtRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const resumeTriedRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /** Poll the settle door until the turn's job ends, then draw what it stored. */
  const follow = useCallback(async (sessionId: string, jobId: string) => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    for (;;) {
      let settled;
      try {
        settled = await settleSharpen(sessionId, jobId, controller.signal);
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return;
        setError(isOutOfCredits(err) ? 'outOfCredits' : 'failed');
        return;
      }
      if (controller.signal.aborted || !mountedRef.current) return;
      if (settled.outcome !== 'pending') {
        setSession(settled.session);
        setError(settled.outcome === 'failed' ? 'failed' : null);
        return;
      }
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      if (controller.signal.aborted || !mountedRef.current) return;
    }
  }, []);

  /** Run one door call: draw its session, then follow its job. */
  const run = useCallback(
    async (call: () => Promise<SharpenDoorResult>) => {
      busyRef.current = true;
      setPending(true);
      setError(null);
      try {
        const result = await call();
        if (!mountedRef.current) return;
        setSession(result.session);
        const job = result.jobId ?? result.session.inFlight?.jobId ?? null;
        if (job) await follow(result.session.id, job);
      } catch (err) {
        if (!mountedRef.current) return;
        const code = codeOf(err);
        setError(
          isOutOfCredits(err)
            ? 'outOfCredits'
            : code === 'SHARPEN_TURN_IN_FLIGHT' || code === 'SHARPEN_SESSION_ENDED'
              ? 'refused'
              : 'failed',
        );
      } finally {
        if (mountedRef.current) {
          busyRef.current = false;
          setPending(false);
        }
      }
    },
    [follow],
  );

  // THE SWITCH. On → arm at today's count. Off while a session is open → Stop
  // (design G4: switching it off while it grills is Stop grilling).
  useEffect(() => {
    if (on === prevOnRef.current) return;
    prevOnRef.current = on;
    if (on) {
      armedAtRef.current = personTurns;
      return;
    }
    armedAtRef.current = null;
    const open = sessionRef.current;
    if (open && open.status === 'open') {
      void run(() => sharpenAct(open.id, 'stop'));
    }
  }, [on, personTurns, run]);

  // RESUME, sending nothing: an open session already on this plan is drawn as it
  // stands (a reload, or the conversation phase entered again).
  useEffect(() => {
    if (!on || !active || !planId || session) return;
    if (resumeTriedRef.current === planId) return;
    resumeTriedRef.current = planId;
    const controller = new AbortController();
    void getOpenSharpen({ planId }, controller.signal)
      .then((open) => {
        if (!mountedRef.current || !open) return;
        setSession((cur) => cur ?? open);
        roundAtRef.current = armedAtRef.current;
        if (open.inFlight?.jobId) void follow(open.id, open.inFlight.jobId);
      })
      .catch(() => {
        // Nothing to resume is not an error the person needs to see.
      });
    return () => controller.abort();
  }, [on, active, planId, session, follow]);

  // OPEN A ROUND: on, in the conversation phase, over the run's plan, for a person
  // turn sent after the switch (and after the last round).
  useEffect(() => {
    if (!on || !active || !planId || busyRef.current) return;
    const armedAt = armedAtRef.current;
    if (armedAt === null || personTurns <= armedAt) return;
    if (roundAtRef.current !== null && personTurns <= roundAtRef.current) return;
    if (session && session.status === 'open') return;
    roundAtRef.current = personTurns;
    // Off the effect's own tick: the open is a request to the door, not a render.
    queueMicrotask(() => void run(() => openSharpen({ planId })));
  }, [on, active, planId, personTurns, session, run]);

  const act = useCallback<GrillSession['act']>(
    (action, opts = {}) => {
      const open = sessionRef.current;
      if (!open || open.status !== 'open' || busyRef.current) return;
      void run(() => sharpenAct(open.id, action, opts));
    },
    [run],
  );

  const stop = useCallback(() => {
    const open = sessionRef.current;
    if (!open || open.status !== 'open') return;
    // Stop is reachable while an act is in flight: the walk ends at its boundary.
    abortRef.current?.abort();
    void run(() => sharpenAct(open.id, 'stop'));
  }, [run]);

  const retry = useCallback(() => {
    const open = sessionRef.current;
    if (!open || busyRef.current) return;
    const turnId = failedPersonTurnId(open) ?? open.inFlight?.turnId ?? null;
    if (!turnId) return;
    void run(() => resubmitSharpen(open.id, turnId));
  }, [run]);

  return { session, pending, error, act, stop, retry };
}
