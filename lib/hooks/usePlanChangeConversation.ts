'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import {
  appendPlanChangeTurn,
  openPlanChangeSession,
  resubmitContextualPlan,
  resumeContextualSession,
  submitContextualPlan,
  submitPlanChange,
} from '@/lib/planning/planChangeClient';
import {
  streamAugmentJob,
  streamContextualPlanJob,
  PlanEditsClientError,
} from '@/lib/planning/planEditsClient';
import { approvePlanRequest, declinePlanRequest } from '@/lib/planning/planReviewClient';
import {
  planDecisionErrorCode,
  readPendingProposal,
  summarizePlanApproval,
  type PlanApproveSummary,
} from '@/lib/planning/planReview';
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
//   settled  → GET  /api/plans/[planId]             (the run's PROPOSALS)
//   approve  → POST /api/plans/[planId]/approve     (materialize — the write)
//   discard  → POST /api/plans/[planId]/decline
//
// ⚠️ It reviews the PLAN, not the job's `planDelta` (MOTIR-1746). Every plan-edit
// handler in motir-ai returns `planDelta: { operations: [] }` and writes its
// output as `PlanItem` proposals instead (`addProposals` → `markPlanned`), so the
// delta read always fell through to `EMPTY`: the user was told nothing was
// proposed while the proposals sat in the Plan store unread, and the Approve
// could never fire. The engine's invariant is that ALL planning appends to a Plan
// — whoever triggered it — so this reads and confirms that Plan, through the same
// route `/plans/[id]` uses. Two entrances, ONE gate.
//
// Three things this deliberately does NOT do:
//  • it does not re-implement the review read or the approve — those are
//    `planReviewClient`'s shipped helpers, the same ones the plan-detail island
//    calls (the compose-don't-reinvent rule);
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

/** `deciding` covers BOTH decisions: approve and discard are now server writes
 *  against the Plan (materialize / decline), so the gate must read busy for
 *  either — a Discard that looked idle mid-POST could be double-fired. */
export type PlanChangePhase = 'loading' | 'idle' | 'streaming' | 'review' | 'deciding';

/** A progress frame the run narrates while the job works. */
export type PlanChangeProgress =
  | { kind: 'submitted' }
  | { kind: 'searching' }
  | { kind: 'drilling' }
  | { kind: 'proposed'; count: number }
  | { kind: 'validating' };

/** What an approve landed, as the rail says it back — the shared summary every
 *  confirming surface reports (`planReviewClient`), re-exported here because the
 *  rail's components type their `onApproved` against the hook. */
export type { PlanApproveSummary };

export interface PlanChangeConversationState {
  phase: PlanChangePhase;
  /** The persisted thread — the resume payload, re-read on mount. */
  session: PlanChangeSessionDto | null;
  /** The live narration of the running job (the `aria-live` line). */
  progress: PlanChangeProgress | null;
  /** The run's PROPOSALS, read from its Plan — what the canvas draws and what the
   *  gate confirms. Pending until approved or discarded. */
  review: PlanReviewDto | null;
  jobId: string | null;
  /**
   * The `Plan` the current run's proposals append into (MOTIR-1743/1745) — what a
   * confirm must address. Set from the submit response, and RE-ESTABLISHED on
   * mount from the resume when the thread left a proposal undecided, so a user
   * who closed the workspace mid-review comes back able to act on it. `null`
   * whenever there is nothing pending, and read defensively: an older response or
   * a stubbed one carries only `jobId`.
   */
  planId: string | null;
  /** The last approve's result, so the rail can say what landed. */
  approved: PlanApproveSummary | null;
  /** A recoverable failure: `FAILED` / `EMPTY` / `immutable` / a typed code. */
  errorCode: string | null;
  /** The metered-AI refusal — a distinct state, not an error (design panel 6). */
  outOfCredits: boolean;
}

const INITIAL: PlanChangeConversationState = {
  phase: 'loading',
  session: null,
  progress: null,
  review: null,
  jobId: null,
  planId: null,
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
  onApproved?: (result: PlanApproveSummary) => void;
  /**
   * The work item this conversation is ANCHORED at, by database id (MOTIR-910's
   * per-item entrance). When set, every hop rides the item-scoped MOTIR-909
   * endpoints instead of the project-wide thread — a different CONVERSATION, not
   * a different mechanism: same substrate, same job kind, same approve route.
   * Absent (the launcher's project/roadmap contexts) → the shipped 7.30 thread.
   */
  anchorId?: string | null;
}

/**
 * What one run is ANCHORED at: the primary anchor (the endpoint's path item) plus
 * the additional targets the `@`-mention picker added (MOTIR-1491). `null` is the
 * project-wide thread. Every hop of a run — submit, stream, resubmit — uses the
 * SAME anchor, because they all address one conversation.
 */
interface RunAnchor {
  anchorId: string;
  targetKeys: string[];
}

/**
 * Which conversation a turn belongs to. The picker's SET wins when the caller
 * has one (an empty set is a real answer — the project thread); a caller that
 * passes nothing keeps the entrance's single anchor.
 */
function resolveAnchor(
  targets: readonly PlanningTarget[] | undefined,
  entranceAnchorId: string | null,
): RunAnchor | null {
  if (targets === undefined) {
    return entranceAnchorId ? { anchorId: entranceAnchorId, targetKeys: [] } : null;
  }
  const primary = primaryPlanningTarget(targets);
  return primary ? { anchorId: primary.id, targetKeys: extraPlanningTargetKeys(targets) } : null;
}

export function usePlanChangeConversation({
  onApproved,
  anchorId = null,
}: UsePlanChangeConversationOptions = {}) {
  const [state, setState] = useState<PlanChangeConversationState>(INITIAL);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // The entrance's anchor, read by callbacks that must not be re-created when it
  // changes (it is fixed per mounted workspace — the route's `?item=`).
  const anchorRef = useRef(anchorId);
  // What the LAST run was anchored at, so a retry resubmits to the same thread —
  // which, once the picker is in play, may be a different set than the entrance's.
  const lastAnchorRef = useRef<RunAnchor | null>(null);
  // A read-only mirror of the latest state, so a callback can read `jobId`/`planId`
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
        // The anchored resume also reports the thread's still-undecided proposal
        // (MOTIR-1745); the project thread's open carries no plan of its own.
        const { session, planId } = anchorId
          ? // Mount-time resume is the ENTRANCE's single anchor: the picker's set
            // is seeded from that same item, and any target the user adds later
            // starts a differently-scoped thread anyway.
            await resumeContextualSession(anchorId, [], controller.signal)
          : { session: await openPlanChangeSession(controller.signal), planId: null };
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, phase: 'idle', session, planId: planId ?? null }));

        // A thread that left a proposal UNDECIDED comes back reviewable: read its
        // Plan and re-enter the gate, so closing the workspace mid-review is not
        // the same as discarding. Its own try: a plan that can't be read is a
        // usable thread with nothing pending, NOT an unavailable session.
        if (!planId) return;
        try {
          const pending = await readPendingProposal(planId, controller.signal);
          if (!mountedRef.current || !pending) return;
          setState((s) => ({ ...s, phase: 'review', review: pending }));
        } catch {
          /* nothing pending we can show — the conversation still works */
        }
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
   *  settle, review) is identical for both threads; only the URL differs. */
  const run = useCallback(
    async (
      anchor: RunAnchor | null,
      submitter?: (
        signal: AbortSignal,
      ) => Promise<{ jobId: string; planId?: string; session: PlanChangeSessionDto }>,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      // Remembered before the hop, so a retry after a failure re-sends to the
      // thread this turn actually landed in.
      lastAnchorRef.current = anchor;
      const submit =
        submitter ??
        (anchor
          ? (signal: AbortSignal) =>
              resubmitContextualPlan(anchor.anchorId, anchor.targetKeys, signal)
          : (signal: AbortSignal) => submitPlanChange(signal));

      try {
        const { jobId, planId, session } = await submit(controller.signal);
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          phase: 'streaming',
          session,
          jobId,
          // A new run supersedes whatever the resume re-attached to, so this is
          // an assignment, not a merge — `undefined` (a stub) clears it.
          planId: planId ?? null,
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
            ) =>
              streamContextualPlanJob(
                anchor.anchorId,
                jobId,
                controller.signal,
                onError,
                onDone,
                onFrame,
              )
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
              phase: s.review ? 'review' : 'idle',
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

        // SETTLED → read what the run actually PROPOSED, from its Plan. The job
        // result is not consulted: its `planDelta` is empty by construction.
        const pending = planId ? await readPendingProposal(planId, controller.signal) : null;
        if (!mountedRef.current) return;
        if (pending) {
          setState((s) => ({
            ...s,
            phase: 'review',
            review: pending,
            progress: null,
            errorCode: null,
          }));
        } else {
          // Nothing came back. The thread stays; the previous proposal (if any) too.
          setState((s) => ({
            ...s,
            phase: s.review ? 'review' : 'idle',
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
          phase: s.review ? 'review' : 'idle',
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

  /**
   * Append what the user typed, then run the ACCUMULATED intent.
   *
   * `targets` is the `@`-mention picker's TARGET SET (MOTIR-1491) and, when
   * given, it is AUTHORITATIVE: its first entry is the primary anchor and the
   * rest ride as additional ones — so removing every target really does make the
   * turn project-wide, rather than silently keeping the entrance's item. Omitting
   * the argument entirely means "no opinion about targets", which falls back to
   * the entrance anchor (MOTIR-910's per-item workspace).
   */
  const send = useCallback(
    async (text: string, targets?: readonly PlanningTarget[]) => {
      const body = text.trim();
      if (!body || abortRef.current) return;

      // ANCHORED: appending and submitting are ONE call (MOTIR-909 resolves and
      // view-gates the anchors first, so the contract fuses them) — `run` does
      // the whole hop, and there is no separate append to fail on its own.
      const anchor = resolveAnchor(targets, anchorRef.current);
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
        await run(anchor, (signal) =>
          submitContextualPlan(anchor.anchorId, body, anchor.targetKeys, signal),
        );
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
          phase: s.review ? 'review' : 'idle',
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
   *  It resubmits to the thread the FAILED run used (its target set included),
   *  not to whatever is picked now — retrying a turn must not quietly re-aim it.
   *  Before any run, that is the entrance's anchor. */
  const retry = useCallback(async () => {
    if (abortRef.current) return;
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
    const anchor =
      lastAnchorRef.current ??
      (anchorRef.current ? { anchorId: anchorRef.current, targetKeys: [] } : null);
    await run(anchor);
  }, [run]);

  /**
   * PERSIST the proposal — `POST /api/plans/[id]/approve` → `approvePlan` →
   * `materialize`, the path that actually writes, behind the 7.12.5 persist gate.
   * It is the SAME operation `/plans/[id]` performs, on the same Plan: two
   * entrances, one gate, no second write path. The thread STAYS.
   */
  const approve = useCallback(async () => {
    const { planId } = stateRef.current;
    if (!planId) return;
    setState((s) => ({ ...s, phase: 'deciding', errorCode: null }));

    try {
      const approved = summarizePlanApproval(await approvePlanRequest(planId));
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'idle',
        review: null,
        jobId: null,
        // Decided: the plan is no longer pending, so its handle goes with the
        // job id rather than lingering as a stale confirm target.
        planId: null,
        approved,
        progress: null,
        errorCode: null,
      }));
      approvedCbRef.current?.(approved);
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, phase: 'review', errorCode: planDecisionErrorCode(err) }));
    }
  }, []);

  /**
   * DISCARD the proposal — `POST /api/plans/[id]/decline`, which drops the
   * proposed items and leaves the tree untouched. It writes to the PLAN (so the
   * run is decided rather than left orphaned at `planned`) and never to the tree.
   * The conversation stays open either way.
   */
  const discard = useCallback(async () => {
    const { planId } = stateRef.current;
    setState((s) => ({ ...s, phase: 'deciding', errorCode: null }));
    try {
      if (planId) await declinePlanRequest(planId);
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        phase: 'idle',
        review: null,
        jobId: null,
        planId: null,
        progress: null,
        errorCode: null,
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      // The proposal is still pending — say so and leave it decidable, rather
      // than clearing a canvas the server still considers awaiting a decision.
      setState((s) => ({
        ...s,
        phase: 'review',
        errorCode: planDecisionErrorCode(err, 'discard'),
      }));
    }
  }, []);

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, errorCode: null, outOfCredits: false }));
  }, []);

  return { state, send, retry, approve, discard, dismissError };
}
