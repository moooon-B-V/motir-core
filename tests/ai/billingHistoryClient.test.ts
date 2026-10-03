import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillingHistory } from '@/lib/ai/motirAiClient';

// THE BILLING-HISTORY CLIENT (MOTIR-7304 over motir-ai's MOTIR-7303 route). The body
// below is motir-ai's own `docs/contract.md` example, so the seam is checked against
// what the route answers rather than a shape this side invented. Every failure
// THROWS: the caller turns a throw into the card's unavailable state.

const ANSWER = {
  paymentMethod: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2028 },
  invoices: [
    {
      id: 'in_123',
      createdAt: '2026-10-01T00:04:11.000Z',
      status: 'paid',
      amountCents: 4900,
      currency: 'eur',
    },
  ],
};

function json(body: unknown, status = 200, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getBillingHistory', () => {
  it('GETs the route with the org and the service credential, and returns the answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(ANSWER));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getBillingHistory({ coreOrganizationId: 'org_1' })).toEqual(ANSWER);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://ai.test/v1/stripe/billing-history?coreOrganizationId=org_1');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('passes the no-customer answer through as the empty shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ paymentMethod: null, invoices: [] })),
    );
    expect(await getBillingHistory({ coreOrganizationId: 'org_1' })).toEqual({
      paymentMethod: null,
      invoices: [],
    });
  });

  it('throws on a problem answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          { code: 'rate_limited', title: 'Rate limited', status: 429 },
          429,
          'application/problem+json',
        ),
      ),
    );
    await expect(getBillingHistory({ coreOrganizationId: 'org_1' })).rejects.toThrow();
  });

  it('throws on a malformed body rather than inventing an empty history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ invoices: 'nope' })),
    );
    await expect(getBillingHistory({ coreOrganizationId: 'org_1' })).rejects.toThrow(
      /malformed body/,
    );
  });
});
