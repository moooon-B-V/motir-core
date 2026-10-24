import { afterEach, describe, expect, it, vi } from 'vitest';

// THE PLAN OFFER's two HTTP doors (Story MOTIR-9219 · MOTIR-9295's coverage floor).
// Each is a pass-through over ONE service call, so the services are stubbed and the
// shipped session gate, rate limit and error mapping are what is under test. The
// decline door's happy path and its 404 / 409 live in `planOfferRow.test.ts`.

const requireCompliantSession = vi.fn();
const getActiveProject = vi.fn();
const enforceAiRateLimit = vi.fn();
const confirmOffer = vi.fn();
const declinePlanOffer = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: () => requireCompliantSession(),
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: () => getActiveProject() }));
vi.mock('@/lib/rateLimit/aiGuard', () => ({
  enforceAiRateLimit: (...a: unknown[]) => enforceAiRateLimit(...a),
}));
vi.mock('@/lib/services/planOfferStartService', () => ({
  planOfferStartService: { confirmOffer: (...a: unknown[]) => confirmOffer(...a) },
}));
vi.mock('@/lib/services/planOfferService', () => ({
  planOfferService: { declinePlanOffer: (...a: unknown[]) => declinePlanOffer(...a) },
}));

const { PlanOfferStartRefusedError } = await import('@/lib/planChange/errors');
const { POST: confirm } = await import('@/app/api/ai/plan-change/session/offer/confirm/route');
const { POST: decline } = await import('@/app/api/ai/plan-change/session/offer/decline/route');

afterEach(() => vi.clearAllMocks());

const CTX = { projectId: 'p1', workspaceId: 'w1', userId: 'u1' };

function request(path: string, body: string) {
  return new Request(`http://localhost/api/ai/plan-change/session/offer/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function signedIn() {
  requireCompliantSession.mockResolvedValue({ ok: true });
  getActiveProject.mockResolvedValue(CTX);
  enforceAiRateLimit.mockResolvedValue(null);
}

const DOORS = [
  ['confirm', confirm, confirmOffer],
  ['decline', decline, declinePlanOffer],
] as const;

describe.each(DOORS)('POST …/offer/%s', (path, door, service) => {
  const post = (body: unknown) => door(request(path, JSON.stringify(body)));

  it('answers the session gate’s own response and calls nothing', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await post({ sessionId: 's1', offerTurnId: 't1' })).status).toBe(401);
    expect(service).not.toHaveBeenCalled();
  });

  it('with no active project answers the shipped refusal and calls nothing', async () => {
    requireCompliantSession.mockResolvedValue({ ok: true });
    getActiveProject.mockResolvedValue(null);
    expect((await post({ sessionId: 's1', offerTurnId: 't1' })).status).toBeGreaterThanOrEqual(400);
    expect(service).not.toHaveBeenCalled();
  });

  it('a body that is not JSON is 400', async () => {
    signedIn();
    expect((await door(request(path, '{nope'))).status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });

  it.each([[{ offerTurnId: 't1' }], [{ sessionId: 's1' }], [{ sessionId: 's1', offerTurnId: 7 }]])(
    'a missing or malformed id is 400 (%j)',
    async (body) => {
      signedIn();
      expect((await post(body)).status).toBe(400);
      expect(service).not.toHaveBeenCalled();
    },
  );

  it('an error the mapping does not know is rethrown, never swallowed as a 200', async () => {
    signedIn();
    service.mockRejectedValue(new Error('boom'));
    await expect(post({ sessionId: 's1', offerTurnId: 't1' })).rejects.toThrow('boom');
  });
});

describe('POST …/offer/confirm', () => {
  const post = (body: unknown) => confirm(request('confirm', JSON.stringify(body)));

  it('calls the start once and answers its result, uncached', async () => {
    signedIn();
    confirmOffer.mockResolvedValue({ sessionId: 's2', jobId: 'j1', planId: 'p1' });
    const res = await post({ sessionId: 's1', offerTurnId: 't1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ sessionId: 's2', jobId: 'j1', planId: 'p1' });
    expect(confirmOffer).toHaveBeenCalledTimes(1);
    expect(confirmOffer).toHaveBeenCalledWith(CTX, { conversationId: 's1', offerTurnId: 't1' });
    expect(enforceAiRateLimit).toHaveBeenCalledWith(CTX, 'ai:generate');
  });

  it('a rate-limited caller is answered by the limiter before the body is read', async () => {
    signedIn();
    enforceAiRateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    expect((await post({ sessionId: 's1', offerTurnId: 't1' })).status).toBe(429);
    expect(confirmOffer).not.toHaveBeenCalled();
  });

  it('a refused start is 409 with its reason', async () => {
    signedIn();
    confirmOffer.mockRejectedValue(new PlanOfferStartRefusedError('target_closed'));
    const res = await post({ sessionId: 's1', offerTurnId: 't1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'target_closed' });
  });
});
