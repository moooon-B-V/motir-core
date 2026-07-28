'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SprintAssignmentDelta } from '@/lib/ai/types';
import type { SprintPlanReviewDto } from '@/lib/dto/aiSprintPlan';
import {
  approveSprintPlan,
  fetchSprintPlanReview,
  streamSprintPlanJob,
  submitSprintPlanJob,
  SprintPlanClientError,
  OUT_OF_CREDITS_CODE,
  SPRINT_PLANNING_DISABLED_CODE,
  type ApproveSprintPlanResponse,
} from '@/lib/planning/sprintPlanClient';

// The AI sprint-planning run, as a phase machine (Subtask MOTIR-1750). Mirrors
// `usePlanEditsJob` — submit → stream → read the result → review → approve —
// with three differences the surface needs:
//
//  * The review model is the SERVER-resolved `SprintPlanReviewDto`, not the raw
//    delta: a packed key alone cannot render a row or a dependency caption.
//  * Progress is NARRATED from the real stream frames. The shipped `plan_sprint`
//    handler emits exactly two: `read` (how much it looked at) and `packed` (what
//    it produced). Every figure the running dock shows comes from one of them —
//    nothing is invented, and a frame that never arrives simply leaves its step
//    running.
//  * Failures are TAXONOMISED rather than collapsed to one "something went
//    wrong", because the design draws a distinct, differently-actionable state
//    per shipped status code.

export type SprintPlanPhase =
  | 'idle'
  | 'submitting'
  | 'running'
  | 'review'
  | 'empty'
  | 'approving'
  | 'error';

/** One drawn failure. Each maps to exactly one shipped status code / error code. */
export type SprintPlanFailure =
  | 'disabled'
  | 'credits'
  | 'unreachable'
  | 'packing'
  | 'notAdmin'
  | 'failed';

/** What the running dock has learned from the stream so far. */
export interface SprintPlanProgress {
  /** `read.packing` — the schedulable items the run actually took in. */
  readCount: number | null;
  /** `packed.sprintLengthDays`. */
  sprintLengthDays: number | null;
  /** Derived from `packed`: `capacityMinutes / sprintLengthDays`. */
  agentMinutesPerDay: number | null;
  /** `packed.sprints` — how many sprints came out. */
  sprintCount: number | null;
}

const NO_PROGRESS: SprintPlanProgress = {
  readCount: null,
  sprintLengthDays: null,
  agentMinutesPerDay: null,
  sprintCount: null,
};

export interface SprintPlanState {
  phase: SprintPlanPhase;
  jobId: string | null;
  review: SprintPlanReviewDto | null;
  progress: SprintPlanProgress;
  failure: SprintPlanFailure | null;
  /** The server's message for the failures that quote one (invalid packing). */
  failureDetail: string | null;
}

const INITIAL: SprintPlanState = {
  phase: 'idle',
  jobId: null,
  review: null,
  progress: NO_PROGRESS,
  failure: null,
  failureDetail: null,
};

function num(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Map a stream `error` frame's code onto a drawn failure. */
export function failureForCode(code: string | null): SprintPlanFailure {
  if (code === OUT_OF_CREDITS_CODE || code === 'out_of_credits') return 'credits';
  if (code === SPRINT_PLANNING_DISABLED_CODE) return 'disabled';
  return 'failed';
}

/**
 * Map a failed REQUEST onto a drawn failure. Status first (it is what the routes
 * actually differentiate on), then the code for the two 4xx that share a status.
 */
export function failureForError(err: unknown): SprintPlanFailure {
  if (!(err instanceof SprintPlanClientError)) return 'failed';
  if (err.status === 402 || err.code === OUT_OF_CREDITS_CODE) return 'credits';
  if (err.status === 409) return 'disabled';
  if (err.status === 403) return 'notAdmin';
  if (err.status === 400) return 'packing';
  if (err.status === 502) return 'unreachable';
  return 'failed';
}

export interface UseSprintPlanJobOptions {
  /** Fired after an approve COMMITS, with what the server created. The host uses
   *  it to refresh the surfaces the write changed (the page-state contract). */
  onApproved?: (result: ApproveSprintPlanResponse) => void;
}

export function useSprintPlanJob({ onApproved }: UseSprintPlanJobOptions = {}) {
  const [state, setState] = useState<SprintPlanState>(INITIAL);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Keep the latest callback reachable without making `approve` depend on it —
  // a host that re-creates the handler each render would otherwise churn the
  // memoized action identity on every parent render.
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  /** Abandon the in-flight run. The job writes nothing either way, so cancelling
   *  costs nothing and leaves no partial state behind. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL);
  }, []);

  /** Close a terminal dock (review / empty / failure) without writing anything. */
  const dismiss = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL);
  }, []);

  const start = useCallback(async () => {
    if (abortRef.current) return;

    setState({ ...INITIAL, phase: 'submitting' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { jobId } = await submitSprintPlanJob(controller.signal);
      if (!mountedRef.current) return;
      setState({ ...INITIAL, phase: 'running', jobId });

      const onFrame = (event: string, data: unknown) => {
        if (!mountedRef.current) return;
        if (event === 'read') {
          const packing = num(data, 'packing') ?? num(data, 'schedulable');
          setState((prev) => ({ ...prev, progress: { ...prev.progress, readCount: packing } }));
          return;
        }
        if (event === 'packed') {
          const days = num(data, 'sprintLengthDays');
          const capacity = num(data, 'capacityMinutes');
          setState((prev) => ({
            ...prev,
            progress: {
              ...prev.progress,
              sprintLengthDays: days,
              // The delta DEFINES capacity as `sprintLengthDays ×
              // agentMinutesPerDay`, so the per-day budget is recoverable from
              // the frame rather than needing a field it does not carry.
              agentMinutesPerDay:
                days !== null && days > 0 && capacity !== null ? Math.round(capacity / days) : null,
              sprintCount: num(data, 'sprints'),
            },
          }));
        }
      };

      const onError = (code: string | null) => {
        if (!mountedRef.current) return;
        abortRef.current = null;
        setState((prev) => ({
          ...prev,
          phase: 'error',
          failure: failureForCode(code),
          failureDetail: null,
        }));
      };

      const onDone = async () => {
        if (!mountedRef.current) return;
        try {
          const review = await fetchSprintPlanReview(jobId, controller.signal);
          if (!mountedRef.current) return;
          abortRef.current = null;
          const hasSprints = (review.proposal?.sprints.length ?? 0) > 0;
          setState((prev) => ({
            ...prev,
            // An empty packing is a VALID result, never an error: everything
            // schedulable is already in a sprint.
            phase: hasSprints ? 'review' : 'empty',
            review,
          }));
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (!mountedRef.current) return;
          abortRef.current = null;
          setState((prev) => ({
            ...prev,
            phase: 'error',
            failure: failureForError(err),
            failureDetail: err instanceof SprintPlanClientError ? err.detail : null,
          }));
        }
      };

      await streamSprintPlanJob(jobId, controller.signal, onError, onDone, onFrame);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!mountedRef.current) return;
      abortRef.current = null;
      setState({
        ...INITIAL,
        phase: 'error',
        failure: failureForError(err),
        failureDetail: err instanceof SprintPlanClientError ? err.detail : null,
      });
    }
  }, []);

  /**
   * Approve the reviewed packing — the ONLY write this flow performs. The delta
   * that goes over the wire is the one the review rendered, so what persists is
   * exactly what was seen; the server re-validates it independently.
   */
  const approve = useCallback(async (jobId: string, delta: SprintAssignmentDelta) => {
    setState((prev) => ({ ...prev, phase: 'approving', failure: null, failureDetail: null }));
    try {
      const result = await approveSprintPlan(jobId, delta);
      if (!mountedRef.current) return;
      abortRef.current = null;
      // The dock must NOT linger showing a proposal that has become real.
      setState(INITIAL);
      onApprovedRef.current?.(result);
    } catch (err) {
      if (!mountedRef.current) return;
      setState((prev) => ({
        ...prev,
        phase: 'error',
        failure: failureForError(err),
        failureDetail: err instanceof SprintPlanClientError ? err.detail : null,
      }));
    }
  }, []);

  return { state, start, cancel, dismiss, approve };
}
