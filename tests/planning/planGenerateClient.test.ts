import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OUT_OF_CREDITS_CODE,
  PlanGenerateError,
  startPlanGeneration,
} from '@/lib/planning/planGenerateClient';

// The 7.4 generation trigger client (Subtask 7.4.9 / MOTIR-1396). It POSTs
// /api/ai/plan/generate and returns { jobId, planId }, mapping the route's typed
// outcomes — crucially the DISTINCT 402 out-of-credits (7.2 metering) the entry
// branches to the credits prompt, never a generic failure.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('startPlanGeneration (MOTIR-1396)', () => {
  it('returns { jobId, planId } on a 200 and POSTs with the optional prompt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { jobId: 'job_1', planId: 'plan_1' }));

    const result = await startPlanGeneration({ prompt: 'payments' });

    expect(result).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/plan/generate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: 'payments' });
  });

  it('sends a null prompt when none is given (generation seeds from the baseline)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { jobId: 'j', planId: 'p' }));

    await startPlanGeneration();

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ prompt: null });
  });

  it('maps a 402 to an out-of-credits PlanGenerateError (the distinct credits outcome)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(402, { code: OUT_OF_CREDITS_CODE, error: 'no credits' }),
    );

    const err = await startPlanGeneration().catch((e) => e);
    expect(err).toBeInstanceOf(PlanGenerateError);
    expect(err.status).toBe(402);
    expect(err.code).toBe(OUT_OF_CREDITS_CODE);
    expect(err.isOutOfCredits).toBe(true);
  });

  it('maps a 502 to a generic (non-credits) PlanGenerateError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(502, { code: 'MOTIR_AI_UNAVAILABLE' }),
    );

    const err = await startPlanGeneration().catch((e) => e);
    expect(err).toBeInstanceOf(PlanGenerateError);
    expect(err.status).toBe(502);
    expect(err.isOutOfCredits).toBe(false);
  });

  it('still throws (code null) when the error body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    const err = await startPlanGeneration().catch((e) => e);
    expect(err).toBeInstanceOf(PlanGenerateError);
    expect(err.code).toBeNull();
    expect(err.isOutOfCredits).toBe(false);
  });
});
