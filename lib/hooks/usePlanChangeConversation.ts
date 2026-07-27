'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanDelta } from '@/lib/ai/planDelta';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import {
  appendPlanChangeTurn,
  openPlanChangeSession,
  submitContextualPlan,
  submitPlanChange,
} from '@/lib/planning/planChangeClient';
import {
  approvePlanDelta,
  fetchJobResult,
  streamAugmentJob,
  streamContextualPlanJob,
  PlanEditsClientError,
  type ApproveDeltaResult,
} from '@/lib/planning/planEditsClient';
import {
  extraPlanningTargetKeys,
  primaryPlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';

// The client state machine behind the plan-change CONVERSATION rail (Subtask
// MOTIR-1730; design `plan-change-conversation.mock.html` panels 3 / 4 / 6). It
// drives the whole loop over ALREADY-SHIPPED surfaces:
//
//   mount    → POST /api/ai/plan-change/session      (open OR RESUME the thread)
//   a turn   → POST …/session/turns  (accumulate)  → POST …/session/submit
//   running  → GET  /api/ai/augment/[jobId]/stream  (the shipped SSE)
//   settled  → GET  /api/ai/jobs/[jobId]            (the PlanDelta)
//   approve  → POST /api/ai/plan-delta/approve      (the MOTIR-1337 substrate)
//
// Three things this deliberately does NOT do:
//  • it does not re-implement submit / stream / approve — those are
//    `planEditsClient`'s shipped helpers (the card's compose-don't-reinvent rule);
//  • it does not close on approve — `approved` is recorded and the phase returns
//    to `idle` with the THREAD INTACT, which is what makes this a conversation
//    rather than a transaction (design panel 6, "after approve");
//  • it does not clear a pending proposal on a FAILED run: the design's error
//    state is "recoverable in place — the thread and any prior proposal survive",
//    so a retry continues the conversation instead of restarting it.
//
// ⚠️ Streaming, against shipped reality: the `augment` job's SSE carries
// STRUCTURED PROGRESS frames (`search` / `drill` / `level_complete` / `pass` /
// `planned` / `validated`), NOT assistant tokens — token streaming belongs to the
// onboarding conductor, a different job kind. So `progress` is the narration
// derived from those real frames, rendered into the rail's `aria-live` region
// with the shipped drafting spinner. Faking a token stream would mean an engine
// change, which this card explicitly does not make.

export type PlanChangePhase = 'loading' | 'idle' | 'streaming' | 'review' | 'approving';

/** A progress frame the run narrates while the job works. */
export type PlanChangeProgress =
  | { kind: 'submitted' }
  | { kind: 'searching' }
  | { kind: 'drilling' }
  | { kind: 'proposed'; count: number }
  | { kind: 'validating' };

export interface PlanChangeConversationState {
  phase: PlanChangePhase;
  /** The persisted thread — the resume payload, re-read on mount. */
  session: PlanChangeSessionDto | null;
  /** The live narration of the running job (the `aria-live` line). */
  progress: PlanChangeProgress | null;
  /** The proposal on the canvas — pending until approved or discarded. */
  delta: PlanDelta | null;
  jobId: string | null;
  /** The last approve's result, so the rail can say what landed. */
  approved: ApproveDeltaResult | null;
  /** A recoverable failure: `FAILED` / `EMPTY` / `immutable` / a typed code. */
  errorCode: string | null;
  /** The metered-AI refusal — a distinct state, not an error (design panel 6). */
  outOfCredits: boolean;
}

const INITIAL: PlanChangeConversationState = {
  phase: 'loading',
  session: null,
  progress: null,
  delta: null,
  jobId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
};

const OUT_OF_CREDITS_CODES = new Set(['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits']);

/** Map one raw SSE frame to the narration the rail shows, or null to ignore it. */
export function narrateFrame(event: string, data: unknown): PlanChangeProgress | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case 'search':
      return { kind: 'searching' };
    case 'drill':
      return { kind: 'drilling' };
    case 'level_complete':
    case 'pass':
    case 'planned': {
      const raw = d['proposed'];
      return { kind: 'proposed', count: typeof raw === 'number' ? raw : 0 };
    }
    case 'validated':
    case 'validation_skipped':
      return { kind: 'validating' };
    default:
      return null;
  }
}

export interface UsePlanChangeConversationOptions {
  /**
   * An approve COMMITTED work items — the caller routes the page-state fan-out
   * (`motir-core/CLAUDE.md`): the canvas is a client island that `router.refresh()`
   * cannot reach, so it needs an explicit refetch trigger, and the server-rendered
   * surfaces behind the workspace take the refresh. Both, where both apply.
   */
  onApproved?: (result: ApproveDeltaResult) => void;
}

/** A submit ANCHORED at a target set — what the contextual endpoint takes. */
interface ContextualAnchor {
  /** The PRIMARY target's work-item id — the route's path item. */
  anchorId: string;
  /** The ADDITIONAL targets, by identifier. */
  targetKeys: string[];
  /** The turn text. The contextual submit appends it itself. */
  prompt: string;
}

export function usePlanChangeConversation({ onApproved }: UsePlanChangeConversationOptions = {}) {
  const [state, setState] = useState<PlanChangeConversationState>(INITIAL);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // What the last submit was anchored at, so `retry` re-sends to the SAME thread.
  const lastAnchorRef = useRef<ContextualAnchor | null>(null);
  // A read-only mirror of the latest state, so a callback can read `jobId`/`delta`
  // without listing them as dependencies (which would re-create the callback — and
  // the rail's handlers — on every stream tick).
  const stateRef = useRef(state);
  // The latest `onApproved` without re-creating `approve` on every parent render.
  const approvedCbRef = useRef(onApproved);
  // Both mirrors are written in an EFFECT (never during render): the callbacks that
  // read them only run from a user event or after an await, by which point effects
  // have flushed.
  useEffect(() => {
    stateRef.current = state;
    approvedCbRef.current = onApproved;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Open OR RESUME the project's thread on mount. Best-effort: a failure leaves an
  // empty thread with a recoverable error, never a broken rail.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await openPlanChangeSession(controller.signal);
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', session }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', errorCode: 'SESSION_UNAVAILABLE' }));
      }
    })();
    return () => controller.abort();
  }, []);

  /** Submit, then stream + settle the job. Shared by `send` (after the turn is
   *  appended, for the project thread) and `retry` (nothing new to append).
   *
   *  `anchor` non-null routes the turn through the CONTEXTUAL endpoint instead
   *  (7.12.3 · MOTIR-909): a thread is identified by its anchor SET, so that one
   *  call opens-or-resumes the scoped thread, appends the turn and submits it. */
  const run = useCallback(async (anchor: ContextualAnchor | null) => {
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { jobId, session } = anchor
        ? await submitContextualPlan(
            anchor.anchorId,
            anchor.targetKeys,
            anchor.prompt,
            controller.signal,
          )
        : await submitPlanChange(controller.signal);
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'streaming',
        session,
        jobId,
        progress: { kind: 'submitted' },
        errorCode: null,
        outOfCredits: false,
      }));

      let failed = false;
      // Same SSE frames either way — a contextual turn IS an augment job; only
      // the route differs, because the anchor is re-gated on subscribe.
      const stream: typeof streamAugmentJob = anchor
        ? (id, signal, onError, onDone, onFrame) =>
            streamContextualPlanJob(anchor.anchorId, id, signal, onError, onDone, onFrame)
        : streamAugmentJob;
      await stream(
        jobId,
        controller.signal,
        (code) => {
          failed = true;
          if (!mountedRef.current) return;
          const gated = code !== null && OUT_OF_CREDITS_CODES.has(code);
          // The thread and any PRIOR proposal survive — recoverable in place.
          setState((s) => ({
            ...s,
            phase: s.delta ? 'review' : 'idle',
            progress: null,
            errorCode: gated ? null : (code ?? 'FAILED'),
            outOfCredits: gated,
          }));
        },
        () => {},
        (event, data) => {
          if (!mountedRef.current) return;
          const progress = narrateFrame(event, data);
          if (progress) setState((s) => ({ ...s, progress }));
        },
      );
      if (failed || !mountedRef.current) return;

      const result = await fetchJobResult(jobId, controller.signal);
      if (!mountedRef.current) return;
      const delta = result.result?.planDelta ?? null;
      if (delta && delta.operations.length > 0) {
        setState((s) => ({ ...s, phase: 'review', delta, progress: null, errorCode: null }));
      } else {
        // Nothing came back. The thread stays; the previous proposal (if any) too.
        setState((s) => ({
          ...s,
          phase: s.delta ? 'review' : 'idle',
          progress: null,
          errorCode: 'EMPTY',
        }));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!mountedRef.current) return;
      const gated = err instanceof PlanEditsClientError && err.isOutOfCredits;
      setState((s) => ({
        ...s,
        phase: s.delta ? 'review' : 'idle',
        progress: null,
        errorCode: gated ? null : 'FAILED',
        outOfCredits: gated,
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  /**
   * Append what the user typed, then run the ACCUMULATED intent.
   *
   * With TARGETS picked (MOTIR-1491) the turn is anchored instead: it goes to the
   * contextual endpoint, which appends it to the thread scoped to that anchor SET
   * — so there is no separate append hop, and the session that comes back is the
   * SCOPED thread, not the project one. Switching targets switches conversation,
   * which is the thread model 7.12.3 defines (scope IS the thread's identity).
   */
  const send = useCallback(
    async (text: string, targets: readonly PlanningTarget[] = []) => {
      const body = text.trim();
      if (!body || abortRef.current) return;

      const primary = primaryPlanningTarget(targets);
      if (primary) {
        const anchor: ContextualAnchor = {
          anchorId: primary.id,
          targetKeys: extraPlanningTargetKeys(targets),
          prompt: body,
        };
        lastAnchorRef.current = anchor;
        setState((s) => ({
          ...s,
          phase: 'streaming',
          progress: { kind: 'submitted' },
          errorCode: null,
          outOfCredits: false,
        }));
        await run(anchor);
        return;
      }

      lastAnchorRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({
        ...s,
        phase: 'streaming',
        progress: { kind: 'submitted' },
        errorCode: null,
        outOfCredits: false,
      }));

      try {
        const session = await appendPlanChangeTurn(body, controller.signal);
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, session }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: s.delta ? 'review' : 'idle',
          progress: null,
          errorCode: 'FAILED',
        }));
        abortRef.current = null;
        return;
      }
      abortRef.current = null;
      await run(null);
    },
    [run],
  );

  /** Re-send the accumulated intent after a failure — no new turn, so the
   *  conversation CONTINUES rather than restarting (design panel 6, error).
   *
   *  A failed CONTEXTUAL turn re-sends to the same anchor set: its submit is one
   *  call that also appends, so the retried turn is appended again — the thread
   *  records the attempt twice, which is the honest trace of what was sent, and
   *  is why the retry cannot silently fall back to the project thread. */
  const retry = useCallback(async () => {
    if (abortRef.current) return;
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
    await run(lastAnchorRef.current);
  }, [run]);

  /** Persist the proposal through the shipped approve route. The thread STAYS. */
  const approve = useCallback(async () => {
    const { jobId, delta } = stateRef.current;
    if (!jobId || !delta) return;
    setState((s) => ({ ...s, phase: 'approving', errorCode: null }));

    try {
      const approved = await approvePlanDelta(jobId, delta);
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'idle',
        delta: null,
        jobId: null,
        approved,
        progress: null,
        errorCode: null,
      }));
      approvedCbRef.current?.(approved);
    } catch (err) {
      if (!mountedRef.current) return;
      const code =
        err instanceof PlanEditsClientError
          ? err.code === 'PLAN_DELTA_IMMUTABLE'
            ? 'immutable'
            : (err.code ?? 'APPROVE_ERROR')
          : 'APPROVE_ERROR';
      setState((s) => ({ ...s, phase: 'review', errorCode: code }));
    }
  }, []);

  /** Drop the proposal. Writes NOTHING — and the conversation stays open. */
  const discard = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: 'idle',
      delta: null,
      jobId: null,
      progress: null,
      errorCode: null,
    }));
  }, []);

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
  }, []);

  return { state, send, retry, approve, discard, dismissError };
}
