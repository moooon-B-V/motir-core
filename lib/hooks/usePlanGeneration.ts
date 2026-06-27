'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';
import {
  OUT_OF_CREDITS_CODE,
  PlanGenerateError,
  startPlanGeneration,
} from '@/lib/planning/planGenerateClient';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The client driver for the 7.4 generation ENTRY (Subtask 7.4.9 / MOTIR-1396).
// It owns the I/O the entry can't: POST `/api/ai/plan/generate` → `{ jobId,
// planId }`, then run TWO concurrent channels against the running job —
//   • the live REVEAL: poll the 7.21 substrate read (`getPlan`) so proposed
//     `add` PlanItems appear per level on the canvas as the engine emits them
//     (the Panel-C design — `7.21 never depends on the 7.4 stream`, so the reveal
//     reads the substrate, exactly like the 847 plan-detail poll); and
//   • the TERMINAL OUTCOME: consume the 7.4 SSE stream (`…/:jobId/stream`) for
//     the typed failure the substrate CANNOT represent — `Plan.status` has no
//     `failed` state, so a mid-generation failure (or out-of-credits) only
//     reaches the UI as the stream's terminal `error` frame (846 ← 8.1.8).
//
// The two channels are COMPLEMENTARY: the poll resolves SUCCESS (`planned` — or
// `empty` when generation produced no proposals, the no-docs taxonomy case), the
// stream resolves FAILURE (`failed` / `out_of_credits`). The first terminal
// outcome wins and aborts the other. On `planned` the entry hands off to the 847
// review surface; everything else renders an in-place terminal state (Panel D).
//
// Mirrors `useDiscoveryChat`'s fetch-ReadableStream + `drainSseFrames` shape (the
// established motir-core SSE-consumer pattern) and `PlanDetail`'s poll cadence.

const POLL_MS = 2500;

export type GenerationPhase =
  | 'idle'
  | 'submitting'
  | 'generating'
  | 'planned' // succeeded, has proposals → hand off to /plans/:id
  | 'empty' // succeeded, NO proposals (no direction docs — the 846 taxonomy case)
  | 'failed'
  | 'out_of_credits';

export interface UsePlanGeneration {
  phase: GenerationPhase;
  /** The opened Plan's id — set the moment the POST returns, before reveal. */
  planId: string | null;
  /** The proposed items revealed so far (fed to the canvas). */
  items: PlanReviewItemDto[];
  /** Bumped on each reveal poll so the canvas re-renders the current level. */
  version: number;
  /** Begin (or restart) a generation. A no-op while one is already running. */
  start: () => void;
  /** Cancel the in-flight generation and return to `idle`. */
  stop: () => void;
}

export function usePlanGeneration(): UsePlanGeneration {
  const [phase, setPhase] = useState<GenerationPhase>('idle');
  const [planId, setPlanId] = useState<string | null>(null);
  const [items, setItems] = useState<PlanReviewItemDto[]>([]);
  const [version, setVersion] = useState(0);

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards the single terminal transition: whichever channel resolves first wins;
  // the other's late frame/poll is ignored so we never overwrite a settled phase.
  const settledRef = useRef(false);

  const teardown = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const settle = useCallback(
    (next: GenerationPhase) => {
      if (settledRef.current || !mountedRef.current) return;
      settledRef.current = true;
      teardown();
      setPhase(next);
    },
    [teardown],
  );

  const start = useCallback(() => {
    if (abortRef.current) return; // already running
    settledRef.current = false;
    setItems([]);
    setVersion(0);
    setPlanId(null);
    setPhase('submitting');

    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      let ids: { jobId: string; planId: string };
      try {
        ids = await startPlanGeneration({}, controller.signal);
      } catch (err) {
        if (isAbort(err) || !mountedRef.current) return;
        settle(
          err instanceof PlanGenerateError && err.isOutOfCredits ? 'out_of_credits' : 'failed',
        );
        return;
      }
      if (!mountedRef.current) return;
      setPlanId(ids.planId);
      setPhase('generating');

      // Channel 1 — the live reveal poll (resolves SUCCESS).
      const poll = async () => {
        try {
          const review = await fetchPlanReview(ids.planId, controller.signal);
          if (!mountedRef.current || settledRef.current) return;
          setItems(review.items);
          setVersion((v) => v + 1);
          if (review.status !== 'generating') {
            settle(review.items.length > 0 ? 'planned' : 'empty');
          }
        } catch {
          /* best-effort — a transient poll failure just retries next tick */
        }
      };
      pollRef.current = setInterval(() => void poll(), POLL_MS);
      void poll(); // kick off immediately so the first level shows fast

      // Channel 2 — the terminal-outcome stream (resolves FAILURE).
      void consumeStream(ids.jobId, controller.signal, settle, () => void poll());
    })();
  }, [settle]);

  const stop = useCallback(() => {
    settledRef.current = true;
    teardown();
    if (mountedRef.current) setPhase('idle');
  }, [teardown]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  return { phase, planId, items, version, start, stop };
}

/** Consume the generate SSE stream for its TERMINAL outcome only. The substrate
 *  poll owns the success path; this owns failure — a typed `error` frame
 *  (out-of-credits vs generic), since `Plan.status` cannot encode a failure. A
 *  `done`/succeeded frame nudges the poll so success shows without a tick wait. */
async function consumeStream(
  jobId: string,
  signal: AbortSignal,
  settle: (phase: GenerationPhase) => void,
  nudgePoll: () => void,
): Promise<void> {
  try {
    const res = await fetch(`/api/ai/plan/generate/${encodeURIComponent(jobId)}/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      // A pre-stream transport failure (e.g. 502, or 402 mid-credit) — read the
      // typed code so out-of-credits stays distinct from a generic failure.
      const code = await readCode(res);
      settle(code === OUT_OF_CREDITS_CODE ? 'out_of_credits' : 'failed');
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = drainSseFrames(buffer);
      buffer = rest;
      for (const { event, data } of frames) {
        if (event === 'error') {
          const code = (data as { code?: string } | null)?.code ?? null;
          settle(code === OUT_OF_CREDITS_CODE ? 'out_of_credits' : 'failed');
          return;
        }
        if (event === 'done' || statusOf(data) === 'succeeded') nudgePoll();
        else if (statusOf(data) === 'failed' || statusOf(data) === 'canceled') {
          // The route appends an `error` frame after a `failed` status with the
          // reason; wait for it (it carries the typed code) — don't pre-settle.
        }
      }
    }
    // Stream closed without an error frame → terminal SUCCESS; let the poll
    // confirm `planned` vs `empty`.
    nudgePoll();
  } catch (err) {
    if (isAbort(err)) return;
    settle('failed');
  }
}

function statusOf(data: unknown): string | null {
  return (data as { status?: string } | null)?.status ?? null;
}

async function readCode(res: Response): Promise<string | null> {
  try {
    return ((await res.json()) as { code?: string }).code ?? null;
  } catch {
    return null;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
