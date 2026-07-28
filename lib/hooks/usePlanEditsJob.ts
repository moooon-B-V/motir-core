'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import {
  submitExpandJob,
  submitReplanJob,
  streamExpandJob,
  streamReplanJob,
  PlanEditsClientError,
} from '@/lib/planning/planEditsClient';
import { approvePlanRequest, declinePlanRequest } from '@/lib/planning/planReviewClient';
import {
  planDecisionErrorCode,
  readPendingProposal,
  summarizePlanApproval,
  type PlanApproveSummary,
} from '@/lib/planning/planReview';

// The state machine behind the ITEM-SCOPED expand / re-plan dock (the `/items`
// row actions, MOTIR-906). It runs the same loop the conversational rail does,
// over the same shipped surfaces:
//
//   submit   → POST /api/ai/expand | /api/ai/replan   ({ jobId, planId })
//   running  → GET  /api/ai/{expand,replan}/[jobId]/stream   (the shipped SSE)
//   settled  → GET  /api/plans/[planId]               (the run's PROPOSALS)
//   approve  → POST /api/plans/[planId]/approve       (materialize — the write)
//   discard  → POST /api/plans/[planId]/decline
//
// ⚠️ It reviews the PLAN, not the job's `planDelta` (MOTIR-1747). Every plan-edit
// handler in motir-ai returns `planDelta: { operations: [] }` and writes its
// output as `PlanItem` proposals instead (`addProposals` → `markPlanned`), so the
// delta read this hook used to do could only ever settle EMPTY — and its Approve,
// guarded on that delta, could never fire. The delta approve route it called is
// gone; there is now exactly ONE proposal→tree write path, `approvePlan` →
// `materialize`, behind the 7.12.5 persist gate. Two entrances, one gate.
//
// Discarding DECLINES the plan rather than just closing the dock: a run whose
// proposals are abandoned client-side would sit at `planned` forever, which the
// auto-plan pause (MOTIR-1740) reads as "a proposal is awaiting review".

export type PlanEditsPhase = 'idle' | 'submitting' | 'running' | 'review' | 'approving' | 'done';

export type PlanEditsJobKind = 'expand' | 'replan';

export interface PlanEditsState {
  phase: PlanEditsPhase;
  jobId: string | null;
  /** The `Plan` this run's proposals append into — what a confirm addresses. */
  planId: string | null;
  /** The run's proposals, read from its Plan. Pending until decided. */
  review: PlanReviewDto | null;
  approved: PlanApproveSummary | null;
  errorCode: string | null;
}

const INITIAL: PlanEditsState = {
  phase: 'idle',
  jobId: null,
  planId: null,
  review: null,
  approved: null,
  errorCode: null,
};

export function usePlanEditsJob() {
  const [state, setState] = useState<PlanEditsState>(INITIAL);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // A read-only mirror, so `approve` / `discard` can read the pending `planId`
  // without listing it as a dependency (which would re-create the callbacks —
  // and the dock's handlers — on every stream tick). Written in an EFFECT, never
  // during render; the callbacks that read it only run from a user event or
  // after an await, by which point effects have flushed.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const teardown = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startJob = useCallback(async (kind: PlanEditsJobKind, payload: { itemKey: string }) => {
    if (abortRef.current) return;

    setState({ ...INITIAL, phase: 'submitting' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const submit = kind === 'expand' ? submitExpandJob : submitReplanJob;
      const { jobId, planId } = await submit(payload.itemKey, controller.signal);

      if (!mountedRef.current) return;
      setState({ ...INITIAL, phase: 'running', jobId, planId: planId ?? null });

      let failed = false;
      const onError = (code: string | null) => {
        failed = true;
        if (!mountedRef.current) return;
        const isOutOfCredits = code === 'MOTIR_AI_OUT_OF_CREDITS' || code === 'out_of_credits';
        setState({
          ...INITIAL,
          jobId,
          planId: planId ?? null,
          errorCode: isOutOfCredits ? 'out_of_credits' : (code ?? 'FAILED'),
        });
      };

      const streamFn = kind === 'expand' ? streamExpandJob : streamReplanJob;
      await streamFn(jobId, controller.signal, onError, () => {});
      if (failed || !mountedRef.current) return;

      // SETTLED → read what the run actually PROPOSED, from its Plan. The job
      // result is not consulted: its `planDelta` is empty by construction.
      try {
        const pending = planId ? await readPendingProposal(planId, controller.signal) : null;
        if (!mountedRef.current) return;
        if (pending) {
          setState({ ...INITIAL, phase: 'review', jobId, planId: planId ?? null, review: pending });
        } else {
          setState({ ...INITIAL, jobId, planId: planId ?? null, errorCode: 'EMPTY' });
        }
      } catch {
        if (!mountedRef.current) return;
        setState({ ...INITIAL, jobId, planId: planId ?? null, errorCode: 'FAILED' });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!mountedRef.current) return;
      const isOutOfCredits = err instanceof PlanEditsClientError && err.isOutOfCredits;
      setState({ ...INITIAL, errorCode: isOutOfCredits ? 'out_of_credits' : 'FAILED' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  /** PERSIST the proposal — `POST /api/plans/[id]/approve` → `materialize`, the
   *  one path that writes, behind the 7.12.5 persist gate. */
  const approve = useCallback(async () => {
    const { planId } = stateRef.current;
    if (!planId) return;
    setState((s) => ({ ...s, phase: 'approving', errorCode: null }));

    try {
      const approved = summarizePlanApproval(await approvePlanRequest(planId));
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, phase: 'done', review: null, planId: null, approved }));
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, phase: 'review', errorCode: planDecisionErrorCode(err) }));
    }
  }, []);

  /** DECLINE the pending proposal (nothing is written to the tree) and close.
   *  A plan is only decidable once it is `planned`, so a run abandoned while it
   *  is still generating just stops streaming — there is nothing to decline. */
  const discard = useCallback(async () => {
    const { planId, review } = stateRef.current;
    teardown();
    if (!planId || !review) {
      setState(INITIAL);
      return;
    }
    setState((s) => ({ ...s, phase: 'approving', errorCode: null }));
    try {
      await declinePlanRequest(planId);
      if (!mountedRef.current) return;
      setState(INITIAL);
    } catch (err) {
      if (!mountedRef.current) return;
      // Still pending server-side — say so and leave it decidable, rather than
      // clearing a dock over a proposal nobody has decided.
      setState((s) => ({
        ...s,
        phase: 'review',
        errorCode: planDecisionErrorCode(err, 'discard'),
      }));
    }
  }, [teardown]);

  return { state, startJob, approve, discard };
}
