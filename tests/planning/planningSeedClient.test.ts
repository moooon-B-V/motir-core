import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPlanningSeed } from '@/lib/planning/planningSeedClient';
import { submitContextualPlan } from '@/lib/planning/planChangeClient';

// MOTIR-6210 — the two CLIENT hops of the seeded re-plan: the seed read the
// overlay opens with, and the `seedGateId` the first send carries. `fetch` is the
// boundary, so `fetch` is what is stubbed.

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
afterEach(() => vi.unstubAllGlobals());

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1)!;
  return [String(call[0]), call[1] ?? {}];
}

const SEED = {
  gateId: 'g/1',
  gateKind: 'decision_approval',
  anchorKey: 'ACME-44',
  firstTurn: 'ACME-44 · Where exports live',
  seededSessionId: null,
};

describe('fetchPlanningSeed', () => {
  it('reads the gate’s seed, addressed by the gate id alone', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ seed: SEED }));
    await expect(fetchPlanningSeed('g/1')).resolves.toEqual(SEED);
    const [url, init] = lastCall();
    expect(url).toBe('/api/approval-gates/g%2F1/planning-seed');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.cache).toBe('no-store');
  });

  it('normalises an absent seededSessionId to null', async () => {
    const { seededSessionId: _dropped, ...older } = SEED;
    void _dropped;
    fetchMock.mockResolvedValue(jsonResponse({ seed: older }));
    expect((await fetchPlanningSeed('g'))?.seededSessionId).toBeNull();
  });

  it('answers null on 404 — the no-existence-leak contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'NOT_FOUND' }, 404));
    await expect(fetchPlanningSeed('g')).resolves.toBeNull();
  });

  it('THROWS on any other failure — an outage is not a missing gate', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    await expect(fetchPlanningSeed('g')).rejects.toThrow(/500/);
  });

  it('lets an abort propagate as the AbortError the signal raised', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(fetchPlanningSeed('g', new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('submitContextualPlan — the seed rides the FIRST turn only', () => {
  const OK = { jobId: 'j', sessionId: 's', session: {} };

  it('carries `seedGateId` when there is no session yet', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK));
    await submitContextualPlan('wi_44', 'Re-plan.', [], undefined, false, null, 'g1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      prompt: 'Re-plan.',
      isAnswer: false,
      seedGateId: 'g1',
    });
  });

  it('never carries it beside a session', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK));
    await submitContextualPlan('wi_44', 'More.', [], undefined, false, 's1', 'g1');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({
      prompt: 'More.',
      isAnswer: false,
      sessionId: 's1',
    });
  });

  it('an unseeded call is byte-for-byte what it was', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK));
    await submitContextualPlan('wi_44', 'Plain.');
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ prompt: 'Plain.', isAnswer: false });
  });
});
