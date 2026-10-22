import { describe, expect, it, vi } from 'vitest';
import { fetchCalculatorCategories, fetchCalculatorEstimate } from '@/lib/billing/calculatorClient';

// The browser call against a stubbed fetch (MOTIR-9004): both paths, both methods,
// the composed body, `no-store`, and each outcome the view switches on.

const ORG = 'org 1';
const BASE = '/api/organizations/org%201/billing/calculator';

function stub(res: Response | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const INPUT = {
  plannedPerMonth: { low: 10, high: 40 },
  runPerMonth: { low: 5, high: 20 },
  categories: ['a', 'b'],
};

describe('fetchCalculatorEstimate', () => {
  it('POSTs the composed body to the estimate path with no-store, and returns the answer', async () => {
    const answer = { kind: 'estimate', version: 2 };
    const f = stub(json(200, answer));
    const out = await fetchCalculatorEstimate(ORG, INPUT, f);
    expect(out).toStrictEqual({ kind: 'answer', value: answer });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/estimate`);
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    expect(JSON.parse(String(init?.body))).toStrictEqual(INPUT);
  });

  it('sends the cadence only when one is given, and never a model', async () => {
    const f = stub(json(200, { kind: 'estimate' }));
    await fetchCalculatorEstimate(ORG, { ...INPUT, cadence: 'monthly' }, f);
    const sent = JSON.parse(String(f.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'cadence',
      'categories',
      'plannedPerMonth',
      'runPerMonth',
    ]);
  });

  it('an empty_category answer arrives inside `answer`', async () => {
    const empty = { kind: 'empty_category', categories: ['a'] };
    expect(await fetchCalculatorEstimate(ORG, INPUT, stub(json(200, empty)))).toStrictEqual({
      kind: 'answer',
      value: empty,
    });
  });

  it('a refusal carries the field the door named', async () => {
    const f = stub(
      json(400, { code: 'CALCULATOR_REQUEST_INVALID', field: 'categories', error: 'x' }),
    );
    expect(await fetchCalculatorEstimate(ORG, INPUT, f)).toStrictEqual({
      kind: 'refused',
      field: 'categories',
    });
  });

  it('a refusal without a field carries null', async () => {
    const f = stub(json(400, { code: 'CALCULATOR_REQUEST_INVALID', error: 'x' }));
    expect(await fetchCalculatorEstimate(ORG, INPUT, f)).toStrictEqual({
      kind: 'refused',
      field: null,
    });
  });

  it('CALCULATOR_UNAVAILABLE is its own outcome', async () => {
    const f = stub(json(503, { code: 'CALCULATOR_UNAVAILABLE', error: 'x' }));
    expect(await fetchCalculatorEstimate(ORG, INPUT, f)).toStrictEqual({ kind: 'unavailable' });
  });

  it.each([
    ['another status', json(502, { code: 'MOTIR_AI_UNAVAILABLE', error: 'x' })],
    ['a 403', json(403, { code: 'BILLING_FORBIDDEN' })],
    ['a non-JSON body', new Response('<html>', { status: 500 })],
    ['an empty 200', new Response('null', { status: 200 })],
    ['a transport error', new TypeError('fetch failed')],
  ])('%s is a plain failure with no server sentence', async (_n, res) => {
    const out = await fetchCalculatorEstimate(ORG, INPUT, stub(res));
    expect(out).toStrictEqual({ kind: 'failed' });
  });
});

describe('fetchCalculatorCategories', () => {
  it('GETs the categories path with no-store and returns the answer', async () => {
    const body = { version: 2, categories: [] };
    const f = stub(json(200, body));
    expect(await fetchCalculatorCategories(ORG, f)).toStrictEqual({ kind: 'answer', value: body });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/categories`);
    expect(init?.method).toBe('GET');
    expect(init?.cache).toBe('no-store');
  });

  it('maps unavailable and a transport error', async () => {
    expect(
      await fetchCalculatorCategories(ORG, stub(json(503, { code: 'CALCULATOR_UNAVAILABLE' }))),
    ).toStrictEqual({ kind: 'unavailable' });
    expect(await fetchCalculatorCategories(ORG, stub(new TypeError('x')))).toStrictEqual({
      kind: 'failed',
    });
  });
});
