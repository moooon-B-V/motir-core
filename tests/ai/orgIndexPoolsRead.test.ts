import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOrgIndexPools } from '@/lib/ai/motirAiClient';
import { parseOrgIndexPools } from '@/lib/ciFleet/indexAllowance';

// THE ORG CARD'S motir-ai READ, UNMOCKED (MOTIR-5341). The service suite mocks the
// client; the parser and total client are exercised here. A body that is not one
// organisation's two pools is `null` — "couldn't read" — never a pool of zeros.
// Motir does not charge for code indexing; this is internal.

const POOLS = {
  known: true,
  isMeta: false,
  tier: { key: 'pro', name: 'Pro', cadence: 'monthly', allotmentCredits: 8000 },
  credit: { balanceCredits: 6240 },
  index: {
    window: '2026-09',
    grantedCredits: 1600,
    consumedCredits: 1792,
    remainingCredits: 0,
    crossingRecorded: true,
  },
  state: 'over_still_indexing',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('parseOrgIndexPools', () => {
  it('reads both pools', () => {
    expect(parseOrgIndexPools(POOLS)).toEqual(POOLS);
  });

  it('reads an org motir-ai never saw as known: false', () => {
    expect(parseOrgIndexPools({ known: false, coreOrganizationId: 'x' })).toEqual({ known: false });
  });

  it('reads a malformed tier as no tier, a missing index as null, and a non-true crossing as false', () => {
    expect(
      parseOrgIndexPools({
        ...POOLS,
        isMeta: 'yes',
        tier: { key: 'pro', name: 'Pro', cadence: 'yearly', allotmentCredits: 8000 },
        index: null,
      }),
    ).toEqual({ ...POOLS, isMeta: false, tier: null, index: null });
    expect(
      parseOrgIndexPools({ ...POOLS, index: { ...POOLS.index, crossingRecorded: 'true' } }),
    ).toMatchObject({ index: { crossingRecorded: false } });
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['no known flag', { state: 'under', credit: { balanceCredits: 1 } }],
    ['no state', { ...POOLS, state: undefined }],
    ['no credit', { ...POOLS, credit: undefined }],
    ['a non-numeric balance', { ...POOLS, credit: { balanceCredits: '6240' } }],
    [
      'an index with a fractional grant',
      { ...POOLS, index: { ...POOLS.index, grantedCredits: 1.5 } },
    ],
    ['an index with no window', { ...POOLS, index: { ...POOLS.index, window: 9 } }],
  ])('refuses %s — never a pool of zeros', (_label, body) => {
    expect(parseOrgIndexPools(body)).toBeNull();
  });
});

describe('fetchOrgIndexPools', () => {
  it('GETs the encoded org id and parses; every failure is null', async () => {
    const fetchMock = vi.fn(async () => json(POOLS));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchOrgIndexPools('org/1')).toEqual(POOLS);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://ai.test/v1/admin/index-allowance/orgs/org%2F1',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'x' }, 500)),
    );
    expect(await fetchOrgIndexPools('org_1')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await fetchOrgIndexPools('org_1')).toBeNull();
  });
});
