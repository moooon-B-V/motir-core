// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePlanGeneration } from '@/lib/hooks/usePlanGeneration';
import { OUT_OF_CREDITS_CODE } from '@/lib/planning/planGenerateClient';

// The 7.4 generation driver (Subtask 7.4.9 / MOTIR-1396). It POSTs the job, then
// runs the live-reveal poll (success → planned/empty) + the SSE stream (failure →
// failed/out_of_credits) concurrently. These tests pin the submit-time outcomes
// (the deterministic paths): the DISTINCT out-of-credits mapping (7.2) vs a
// generic failure, and the transition into the generating reveal. The terminal
// reveal/stream resolution is covered by the GenerationFlow component test.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An immediately-closed SSE body (no error frame ⇒ the stream signals success). */
function emptyStream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('usePlanGeneration (MOTIR-1396)', () => {
  it('maps a 402 submit to the out_of_credits phase (the distinct credits outcome)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(402, { code: OUT_OF_CREDITS_CODE }),
    );

    const { result } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('out_of_credits'));
  });

  it('maps a non-credits submit failure (502) to the failed phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(502, { code: 'MOTIR_AI_UNAVAILABLE' }),
    );

    const { result } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('failed'));
  });

  it('transitions to generating with the opened planId after a successful submit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/ai/plan/generate') {
        return Promise.resolve(jsonResponse(200, { jobId: 'job_1', planId: 'plan_1' }));
      }
      if (url.includes('/stream')) return Promise.resolve(emptyStream());
      // The reveal poll (/api/plans/:id) — still generating, no items yet.
      return Promise.resolve(
        jsonResponse(200, {
          id: 'plan_1',
          projectId: 'p',
          status: 'generating',
          title: null,
          summary: null,
          itemCount: 0,
          createdAt: '2026-06-26T00:00:00.000Z',
          plannedAt: null,
          decidedAt: null,
          decidedByName: null,
          history: [],
          items: [],
          stale: false,
          staleCount: 0,
        }),
      );
    });

    const { result, unmount } = renderHook(() => usePlanGeneration());
    act(() => result.current.start());

    await waitFor(() => expect(result.current.phase).toBe('generating'));
    expect(result.current.planId).toBe('plan_1');
    unmount(); // aborts the poll/stream
  });
});
