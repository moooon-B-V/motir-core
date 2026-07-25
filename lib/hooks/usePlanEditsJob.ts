'use client';

import { useCallback, useRef, useState } from 'react';
import type { PlanDelta } from '@/lib/ai/planDelta';
import {
  approvePlanDelta,
  fetchJobResult,
  submitAugmentJob,
  submitExpandJob,
  submitReplanJob,
  streamAugmentJob,
  streamExpandJob,
  streamReplanJob,
  PlanEditsClientError,
  type ApproveDeltaResult,
} from '@/lib/planning/planEditsClient';

export type PlanEditsPhase = 'idle' | 'submitting' | 'running' | 'review' | 'approving' | 'done';

export type PlanEditsJobKind = 'augment' | 'expand' | 'replan';

export interface PlanEditsState {
  phase: PlanEditsPhase;
  jobId: string | null;
  delta: PlanDelta | null;
  approved: ApproveDeltaResult | null;
  errorCode: string | null;
}

export function usePlanEditsJob() {
  const [state, setState] = useState<PlanEditsState>({
    phase: 'idle',
    jobId: null,
    delta: null,
    approved: null,
    errorCode: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const teardown = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startJob = useCallback(
    async (kind: PlanEditsJobKind, payload: { prompt?: string; itemKey?: string }) => {
      if (abortRef.current) return;

      setState({ phase: 'submitting', jobId: null, delta: null, approved: null, errorCode: null });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        let jobId: string;
        if (kind === 'augment') {
          ({ jobId } = await submitAugmentJob(payload.prompt!, controller.signal));
        } else if (kind === 'expand') {
          ({ jobId } = await submitExpandJob(payload.itemKey!, controller.signal));
        } else {
          ({ jobId } = await submitReplanJob(payload.itemKey!, controller.signal));
        }

        if (!mountedRef.current) return;
        setState({ phase: 'running', jobId, delta: null, approved: null, errorCode: null });

        const onError = (code: string | null) => {
          if (!mountedRef.current) return;
          const isOutOfCredits = code === 'MOTIR_AI_OUT_OF_CREDITS' || code === 'out_of_credits';
          setState({
            phase: 'idle',
            jobId,
            delta: null,
            approved: null,
            errorCode: isOutOfCredits ? 'out_of_credits' : (code ?? 'FAILED'),
          });
        };

        const onDone = async () => {
          if (!mountedRef.current) return;
          try {
            const jobResult = await fetchJobResult(jobId, controller.signal);
            if (!mountedRef.current) return;
            const delta = jobResult.result?.planDelta ?? null;
            if (delta && delta.operations.length > 0) {
              setState({ phase: 'review', jobId, delta, approved: null, errorCode: null });
            } else {
              setState({
                phase: 'idle',
                jobId,
                delta: null,
                approved: null,
                errorCode: 'EMPTY',
              });
            }
          } catch {
            if (!mountedRef.current) return;
            setState({
              phase: 'idle',
              jobId,
              delta: null,
              approved: null,
              errorCode: 'FAILED',
            });
          }
        };

        const streamFn =
          kind === 'augment'
            ? streamAugmentJob
            : kind === 'expand'
              ? streamExpandJob
              : streamReplanJob;
        await streamFn(jobId, controller.signal, onError, onDone);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!mountedRef.current) return;
        const isOutOfCredits = err instanceof PlanEditsClientError && err.isOutOfCredits;
        setState({
          phase: 'idle',
          jobId: null,
          delta: null,
          approved: null,
          errorCode: isOutOfCredits ? 'out_of_credits' : 'FAILED',
        });
      }
    },
    [],
  );

  const approve = useCallback(
    async (editedDelta?: PlanDelta) => {
      if (!state.jobId) return;
      setState((s) => ({ ...s, phase: 'approving' }));

      try {
        const result = await approvePlanDelta(state.jobId, editedDelta ?? state.delta);
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: 'done',
          approved: result,
          errorCode: null,
        }));
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
    },
    [state.jobId, state.delta],
  );

  const cancel = useCallback(() => {
    teardown();
    setState({ phase: 'idle', jobId: null, delta: null, approved: null, errorCode: null });
  }, [teardown]);

  const dismissReview = useCallback(() => {
    setState({ phase: 'idle', jobId: null, delta: null, approved: null, errorCode: null });
  }, []);

  return { state, startJob, approve, cancel, dismissReview };
}
