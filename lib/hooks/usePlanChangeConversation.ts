'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanDelta } from '@/lib/ai/planDelta';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import {
  appendPlanChangeTurn,
  openPlanChangeSession,
  resubmitContextualPlan,
  resumeContextualSession,
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
  /**
   * The work item this conversation is ANCHORED at, by database id (MOTIR-910's
   * per-item entrance). When set, every hop rides the item-scoped MOTIR-909
   * endpoints instead of the project-wide thread — a different CONVERSATION, not
   * a different mechanism: same substrate, same job kind, same approve route.
   * Absent (the launcher's project/roadmap contexts) → the shipped 7.30 thread.
   */
  anchorId?: string | null;
}

export function usePlanChangeConversation({
  onApproved,
  anchorId = null,
}: UsePlanChangeConversationOptions = {}) {
  const [state, setState] = useState<PlanChangeConversationState>(INITIAL);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // The anchor, read by callbacks that must not be re-created when it changes
  // (it is fixed per mounted workspace — the route's `?item=`).
  const anchorRef = useRef(anchorId);
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
    anchorRef.current = anchorId;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Open OR RESUME the thread on mount — the project's, or the ANCHORED item's.
  // Best-effort: a failure leaves an empty thread with a recoverable error, never
  // a broken rail. An anchored item that was never planned simply has no thread
  // yet (`null`), which is an empty rail, not an error.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const session = anchorId
          ? await resumeContextualSession(anchorId, controller.signal)
          : await openPlanChangeSession(controller.signal);
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', session }));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', errorCode: 'SESSION_UNAVAILABLE' }));
      }
    })();
    return () => controller.abort();
  }, [anchorId]);

  /** Submit the thread's ACCUMULATED intent, then stream + settle the job. Shared
   *  by `send` (after the turn is appended) and `retry` (nothing new to append).
   *
   *  `submitter` is what actually sends: the project submit, the anchored
   *  resubmit, or — anchored — the ONE call that appends the new turn AND submits
   *  it (the MOTIR-909 contract fuses those two). Everything downstream (stream,
   *  settle, delta) is identical for both threads; only the URL differs. */
  const run = useCallback(
    async (
      submitter?: (
        signal: AbortSignal,
      ) => Promise<{ jobId: string; session: PlanChangeSessionDto }>,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const anchor = anchorRef.current;
      const submit =
        submitter ??
        (anchor
          ? (signal: AbortSignal) => resubmitContextualPlan(anchor, signal)
          : (signal: AbortSignal) => submitPlanChange(signal));

      try {
        const { jobId, session } = await submit(controller.signal);
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
        // Anchored runs subscribe through the item's own relay (which re-gates the
        // anchor on subscribe); the project thread keeps the shipped augment SSE.
        const stream = anchor
          ? (
              onError: (code: string | null) => void,
              onDone: () => void,
              onFrame: (event: string, data: unknown) => void,
            ) => streamContextualPlanJob(anchor, jobId, controller.signal, onError, onDone, onFrame)
          : (
              onError: (code: string | null) => void,
              onDone: () => void,
              onFrame: (event: string, data: unknown) => void,
            ) => streamAugmentJob(jobId, controller.signal, onError, onDone, onFrame);
        await stream(
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
    },
    [],
  );

  /** Append what the user typed, then run the ACCUMULATED intent. */
  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || abortRef.current) return;

      // ANCHORED: appending and submitting are ONE call (MOTIR-909 resolves and
      // view-gates the anchors first, so the contract fuses them) — `run` does
      // the whole hop, and there is no separate append to fail on its own.
      const anchor = anchorRef.current;
      if (anchor) {
        // Busy from the click, not from the response: the composer must lock
        // immediately or a second Enter fires a second turn (the project branch
        // below gets this from its own optimistic set).
        setState((s) => ({
          ...s,
          phase: 'streaming',
          progress: { kind: 'submitted' },
          errorCode: null,
          outOfCredits: false,
        }));
        await run((signal) => submitContextualPlan(anchor, body, signal));
        return;
      }

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
      await run();
    },
    [run],
  );

  /** Re-send the accumulated intent after a failure — no new turn, so the
   *  conversation CONTINUES rather than restarting (design panel 6, error). */
  const retry = useCallback(async () => {
    if (abortRef.current) return;
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
    await run();
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
