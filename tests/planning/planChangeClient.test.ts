import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openPlanChangeSession,
  appendPlanChangeTurn,
  submitPlanChange,
} from '@/lib/planning/planChangeClient';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';

// The conversation's CLIENT transport (Story 7.30 · MOTIR-1728's routes, consumed
// by MOTIR-1730's rail) — the one module in this story that shipped with NO test
// at all, so the story-level coverage gate (MOTIR-1732) writes its floor here.
//
// What it must prove is the contract the rail leans on and the hook's mocks hide:
// every call is an HTTP hop to a SHIPPED `/api/ai/plan-change/session*` endpoint
// (never a service import — the client/service boundary guard asserts the other
// direction), the request shape each endpoint expects, and the single error type
// a caller branches on. `fetch` is the boundary, so `fetch` is what is stubbed —
// nothing else is.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The single request `fetch` was called with. */
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

const SESSION = {
  id: 's1',
  projectId: 'p1',
  turnCount: 1,
  lastJobId: null,
  lastSubmittedAt: null,
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T09:00:00.000Z',
  turns: [],
};

describe('planChangeClient — the three session calls hit the SHIPPED endpoints', () => {
  it('opens/resumes the thread with a bodyless POST', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await expect(openPlanChangeSession()).resolves.toEqual(SESSION);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session');
    expect(init.method).toBe('POST');
    // The open call carries NO body — passing `undefined` must omit the key
    // entirely rather than serialize `"undefined"`, which the route would 400.
    expect('body' in init).toBe(false);
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('appends a turn as { body } to the turns endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(SESSION));

    await expect(appendPlanChangeTurn('Split the billing epic')).resolves.toEqual(SESSION);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/turns');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'Split the billing epic' });
  });

  it('submits the accumulated intent and returns the shipped job id + session', async () => {
    const result = { jobId: 'job-augment-1', session: SESSION };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(submitPlanChange()).resolves.toEqual(result);

    const [url, init] = lastCall();
    expect(url).toBe('/api/ai/plan-change/session/submit');
    expect(init.method).toBe('POST');
    // Submit sends nothing either — the intent is the PERSISTED thread, not a
    // client-side payload. That is the whole point of the seam.
    expect('body' in init).toBe(false);
  });

  it('forwards the abort signal so an unmounting rail cancels in flight', async () => {
    // A fresh Response per call — a body may only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(SESSION));
    const controller = new AbortController();

    await openPlanChangeSession(controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    await appendPlanChangeTurn('x', controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);

    await submitPlanChange(controller.signal);
    expect(lastCall()[1].signal).toBe(controller.signal);
  });
});

describe('planChangeClient — failures surface as ONE error type', () => {
  it('throws PlanEditsClientError carrying the status and the typed code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'PLAN_CHANGE_SESSION_NOT_FOUND' }, 404));

    const err = await appendPlanChangeTurn('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(404);
    expect((err as PlanEditsClientError).code).toBe('PLAN_CHANGE_SESSION_NOT_FOUND');
  });

  it('degrades to a null code when the error body is not JSON', async () => {
    // A proxy/edge 502 with an HTML body must still raise the typed error, not
    // an unhandled parse throw — the rail branches on the class, not the body.
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));

    const err = await submitPlanChange().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect((err as PlanEditsClientError).status).toBe(502);
    expect((err as PlanEditsClientError).code).toBeNull();
  });

  it('degrades to a null code when the JSON error body carries no code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 400));

    const err = await openPlanChangeSession().catch((e: unknown) => e);
    expect((err as PlanEditsClientError).code).toBeNull();
  });

  it('reports the metered-AI refusal through the SHARED isOutOfCredits flag', async () => {
    // The reason this module reuses `PlanEditsClientError` rather than minting
    // its own: the rail's out-of-credits branch is one check for every AI call.
    fetchMock.mockResolvedValue(jsonResponse({ code: 'MOTIR_AI_OUT_OF_CREDITS' }, 402));

    const err = (await submitPlanChange().catch((e: unknown) => e)) as PlanEditsClientError;
    expect(err.isOutOfCredits).toBe(true);
  });
});
