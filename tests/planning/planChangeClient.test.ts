import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openPlanChangeSession,
  appendPlanChangeTurn,
  resubmitContextualPlan,
  resumeContextualSession,
  submitContextualPlan,
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

describe('planChangeClient — the MULTI-TARGET anchors (MOTIR-1491)', () => {
  it('carries the ADDITIONAL targets beside the prompt; the primary stays the path item', async () => {
    const result = { jobId: 'job-ctx-1', sessionId: 's-ctx', session: SESSION };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(
      submitContextualPlan('wi_812', 'Expand billing.', ['MOTIR-918', 'MOTIR-922']),
    ).resolves.toEqual(result);

    const [url, init] = lastCall();
    // The SHIPPED 7.12.3 endpoint — the picker adds no route of its own.
    expect(url).toBe('/api/work-items/wi_812/ai/plan');
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'Expand billing.',
      // The primary is NOT repeated: it travels as the path item and the service
      // adds it to the scope itself.
      targetKeys: ['MOTIR-918', 'MOTIR-922'],
    });
  });

  it('OMITS the field entirely with no additional targets — the single-anchor request is unchanged', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j', sessionId: 's', session: SESSION }));

    await submitContextualPlan('wi_812', 'Re-plan this story.');

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ prompt: 'Re-plan this story.' });
  });

  it('a RESUBMIT re-sends to the same anchor SET — retrying must not re-aim the turn', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j', sessionId: 's', session: SESSION }));

    await resubmitContextualPlan('wi_812', ['MOTIR-918']);

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      resubmit: true,
      targetKeys: ['MOTIR-918'],
    });
  });

  it('RESUMES a multi-anchor thread through repeated ?targetKey= params', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session: SESSION }));

    await resumeContextualSession('wi_812', ['MOTIR-918', 'MOTIR-922']);

    expect(lastCall()[0]).toBe(
      '/api/work-items/wi_812/ai/plan?targetKey=MOTIR-918&targetKey=MOTIR-922',
    );
  });
});

describe('planChangeClient — the planId echo is read DEFENSIVELY (MOTIR-1745)', () => {
  it('carries the submit’s planId when the response has one', async () => {
    const result = { jobId: 'job-ctx-1', planId: 'plan_1', sessionId: 's-ctx', session: SESSION };
    fetchMock.mockResolvedValue(jsonResponse(result));

    await expect(submitContextualPlan('wi_812', 'Expand billing.')).resolves.toEqual(result);
  });

  it('still parses a submit response carrying ONLY a jobId', async () => {
    // The whole reason the browser-facing type keeps `planId` optional: an E2E
    // stub, a fixture, or a pre-1745 deployment answers without it, and the rail
    // must degrade to "nothing to confirm" rather than fail to parse.
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'job-ctx-1', session: SESSION }));

    const res = await submitPlanChange();
    expect(res.jobId).toBe('job-ctx-1');
    expect(res.planId).toBeUndefined();
  });

  it('returns the resume ENVELOPE, normalizing a missing planId to null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ session: SESSION, planId: 'plan_7' }));
    await expect(resumeContextualSession('wi_812')).resolves.toEqual({
      session: SESSION,
      planId: 'plan_7',
    });

    // No thread, and a response predating the field, both read as "nothing
    // pending" — the caller branches on one shape, never on `undefined`.
    fetchMock.mockResolvedValue(jsonResponse({ session: null }));
    await expect(resumeContextualSession('wi_812')).resolves.toEqual({
      session: null,
      planId: null,
    });
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

// ─── The ITEM-ANCHORED calls (MOTIR-910 → the MOTIR-909 endpoints) ───────────

describe('the anchored transport — a work item’s own thread', () => {
  it('resumes by GET, and reads an unplanned item as null rather than an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: null }));
    // The ENVELOPE, not the bare session (MOTIR-1745) — a resume also reports the
    // thread's pending proposal, so an unplanned item reads as null on both.
    expect(await resumeContextualSession('wi_123')).toEqual({ session: null, planId: null });

    const [url, init] = lastCall();
    expect(url).toBe('/api/work-items/wi_123/ai/plan');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('returns the thread when the item has one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: SESSION }));
    expect(await resumeContextualSession('wi_123')).toMatchObject({
      session: { id: SESSION.id },
    });
  });

  it('submits a turn as ONE POST carrying the prompt — the reason IS the turn', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobId: 'job-1', sessionId: 's1', session: SESSION }),
    );
    const result = await submitContextualPlan('wi_123', 'Split this story.');

    expect(result.jobId).toBe('job-1');
    const [url, init] = lastCall();
    expect(url).toBe('/api/work-items/wi_123/ai/plan');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ prompt: 'Split this story.' });
  });

  it('retries with the resubmit flag and NO prompt — nothing new is said', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobId: 'job-2', sessionId: 's1', session: SESSION }),
    );
    await resubmitContextualPlan('wi_123');

    const [, init] = lastCall();
    expect(JSON.parse(init.body as string)).toEqual({ resubmit: true });
  });

  it('encodes the anchor id into the path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ session: null }));
    await resumeContextualSession('wi/123');
    expect(lastCall()[0]).toBe('/api/work-items/wi%2F123/ai/plan');
  });

  it('raises the ONE error type a caller branches on, carrying the typed code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'WORK_ITEM_NOT_FOUND' }, 404));
    await expect(resumeContextualSession('wi_gone')).rejects.toBeInstanceOf(PlanEditsClientError);

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'MOTIR_AI_OUT_OF_CREDITS' }, 402));
    await expect(submitContextualPlan('wi_123', 'x')).rejects.toMatchObject({
      isOutOfCredits: true,
    });
  });
});
