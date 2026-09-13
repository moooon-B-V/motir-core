import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchIndexAllowanceSummary, fetchOrgTiers } from '@/lib/ai/motirAiClient';
import {
  DEFAULT_RECALC_THRESHOLD_PCT,
  parseIndexAllowanceSummary,
  parseOrgTiers,
  readRecalcThreshold,
} from '@/lib/ciFleet/indexAllowance';

// THE MONITORING SECTION'S motir-ai READS, UNMOCKED (MOTIR-4595). The service suite
// mocks the client, so these parsers and total clients are exercised here directly.
// A body that is not the answer is `null` — "could not ask" — never a partial summary
// read as zeros. Motir does not charge for code indexing; this is internal.

const TIER = {
  tierKey: 'standard',
  tierName: 'Standard',
  cadence: 'monthly',
  allotmentCredits: 2000,
  orgs: 412,
  crossed: 37,
  exhausted: null,
  grantedCreditsPerOrg: 400,
  configured: true,
};
const SUMMARY = { window: '2026-09', ratio: 0.2, untieredOrgs: 3, tiers: [TIER] };

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

describe('parseIndexAllowanceSummary', () => {
  it('reads a well-formed summary', () => {
    expect(parseIndexAllowanceSummary(SUMMARY)).toEqual(SUMMARY);
  });

  it('reads an absent ratio as null and a missing untiered count as 0', () => {
    expect(parseIndexAllowanceSummary({ window: '2026-09', tiers: [], ratio: Number.NaN })).toEqual(
      {
        window: '2026-09',
        ratio: null,
        untieredOrgs: 0,
        tiers: [],
      },
    );
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['no window', { tiers: [] }],
    ['tiers not an array', { window: '2026-09', tiers: {} }],
    ['a tier that is not an object', { window: '2026-09', tiers: [null] }],
    ['an unknown cadence', { window: '2026-09', tiers: [{ ...TIER, cadence: 'weekly' }] }],
    ['a negative count', { window: '2026-09', tiers: [{ ...TIER, orgs: -1 }] }],
    ['a fractional crossed', { window: '2026-09', tiers: [{ ...TIER, crossed: 1.5 }] }],
    ['a non-boolean configured', { window: '2026-09', tiers: [{ ...TIER, configured: 'yes' }] }],
  ])('refuses %s — never a partial summary', (_label, body) => {
    expect(parseIndexAllowanceSummary(body)).toBeNull();
  });
});

describe('parseOrgTiers', () => {
  it('maps each org to its tier, and a missing or non-string tier to null', () => {
    const map = parseOrgTiers({
      orgs: [
        { coreOrganizationId: 'a', tierKey: 'free' },
        { coreOrganizationId: 'b', tierKey: null },
        { coreOrganizationId: 'c' },
      ],
    });
    expect(map && [...map.entries()]).toEqual([
      ['a', 'free'],
      ['b', null],
      ['c', null],
    ]);
  });

  it.each([
    ['not an object', 7],
    ['no orgs array', { orgs: 'x' }],
    ['an entry that is not an object', { orgs: [null] }],
    ['an entry with no id', { orgs: [{ tierKey: 'free' }] }],
  ])('refuses %s', (_label, body) => {
    expect(parseOrgTiers(body)).toBeNull();
  });
});

describe('readRecalcThreshold', () => {
  it('defaults to the design’s 25%, provisional, when unset or blank', () => {
    expect(readRecalcThreshold(undefined)).toEqual({
      pct: DEFAULT_RECALC_THRESHOLD_PCT,
      provisional: true,
    });
    expect(readRecalcThreshold('  ')).toEqual({ pct: 25, provisional: true });
  });

  it('takes a configured percentage, and falls back to provisional on nonsense', () => {
    expect(readRecalcThreshold('40')).toEqual({ pct: 40, provisional: false });
    for (const bad of ['0', '-5', '101', 'lots']) {
      expect(readRecalcThreshold(bad)).toEqual({ pct: 25, provisional: true });
    }
  });

  it('reads the environment when called with no argument', () => {
    vi.stubEnv('INDEX_ALLOWANCE_RECALC_THRESHOLD_PCT', '30');
    expect(readRecalcThreshold()).toEqual({ pct: 30, provisional: false });
  });
});

describe('the total clients', () => {
  it('fetchIndexAllowanceSummary GETs the window and parses; every failure is null', async () => {
    const fetchMock = vi.fn(async () => json(SUMMARY));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchIndexAllowanceSummary('2026-09')).toEqual(SUMMARY);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://ai.test/v1/admin/index-allowance/summary?window=2026-09',
    );
    await fetchIndexAllowanceSummary();
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe(
      'https://ai.test/v1/admin/index-allowance/summary',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'x' }, 500)),
    );
    expect(await fetchIndexAllowanceSummary()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await fetchIndexAllowanceSummary()).toBeNull();
  });

  it('fetchOrgTiers POSTs the batch and parses; empty asks nothing; every failure is null', async () => {
    const fetchMock = vi.fn(async () =>
      json({ orgs: [{ coreOrganizationId: 'a', tierKey: 'pro' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchOrgTiers([])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchOrgTiers(['a'])).toEqual(new Map([['a', 'pro']]));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ coreOrganizationIds: ['a'] });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 503)),
    );
    expect(await fetchOrgTiers(['a'])).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await fetchOrgTiers(['a'])).toBeNull();
  });
});
