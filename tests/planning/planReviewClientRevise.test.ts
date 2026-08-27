import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanRequestError, revisePlanRequest } from '@/lib/planning/planReviewClient';

// Story MOTIR-3595 · Subtask MOTIR-3601 — the client half of the revision submit.
//
// Small, and the reason it is tested at all is the SECOND case: the surface
// branches on the code this function throws. A refusal that arrives as a
// `PLAN_REVISION_IN_FLIGHT` renders "a revision is changing this plan"; anything
// else renders the generic action error. So the code has to survive the trip
// intact, and the fallback has to be a code rather than an undefined.

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('revisePlanRequest', () => {
  it('posts the plan id and the instruction, and returns the SAME plan id', async () => {
    respond({ jobId: 'job_1', planId: 'plan_1' });

    const result = await revisePlanRequest('plan_1', 'Split the second story in two');

    expect(result).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/revise');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      planId: 'plan_1',
      prompt: 'Split the second story in two',
    });
  });

  it('carries the server’s CODE through — the surface branches on it', async () => {
    respond({ code: 'PLAN_REVISION_IN_FLIGHT', error: 'held' }, 409);

    const err = await revisePlanRequest('plan_1', 'Split it').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as PlanRequestError).code).toBe('PLAN_REVISION_IN_FLIGHT');
    expect((err as PlanRequestError).status).toBe(409);
  });

  it('falls back to a CODE, never undefined, when the body carries none', async () => {
    respond({}, 500);
    const err = await revisePlanRequest('plan_1', 'Split it').catch((e: unknown) => e);
    expect((err as PlanRequestError).code).toBe('REVISE_FAILED');
  });

  it('survives a body that is not JSON at all — a proxy’s HTML error page', async () => {
    // The `.catch(() => ({}))` arm. Without it a 502 from something in front of
    // the app throws a SyntaxError out of the client, and the surface reports a
    // parse failure instead of the refusal the reader can act on.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    const err = await revisePlanRequest('plan_1', 'Split it').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as PlanRequestError).code).toBe('REVISE_FAILED');
    expect((err as PlanRequestError).status).toBe(502);
  });
});
