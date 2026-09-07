import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anyRepositoryIndexed,
  fetchPlanningSubstrate,
  SUBSTRATE_POLL_CEILING_MS,
  SUBSTRATE_POLL_INTERVAL_MS,
} from '@/lib/planning/substratePoll';
import type { OnboardingSubstrate } from '@/lib/dto/onboardingSubstrate';

// THE WAIT'S OWN INSTRUMENT (Story MOTIR-4753 · MOTIR-4829).
//
// ⚠️ EVERY FAILURE IS A CONTINUE, NEVER A CONCLUSION — and that is the whole
// point of this suite. A dead request, a 404, a body that does not parse: none
// of those is evidence the index finished or failed, so the poll must answer
// `null` and let the surface keep saying the true thing. A seam that threw, or
// that guessed, would turn a network blip into a decision about somebody's
// project.

const substrate = (over: Partial<OnboardingSubstrate> = {}): OnboardingSubstrate => ({
  itemCount: 12,
  itemCountTruncated: false,
  repositories: [{ ref: 'acme/widgets', indexed: false }],
  repositoryConnected: true,
  repositoryIndexed: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (impl: () => unknown) => vi.stubGlobal('fetch', vi.fn(impl));

describe('fetchPlanningSubstrate', () => {
  it('returns the substrate on a well-formed answer', async () => {
    const body = substrate();
    stubFetch(() => ({ ok: true, json: async () => body }));
    expect(await fetchPlanningSubstrate()).toEqual(body);
  });

  it('asks with no-store — a cached answer is a window that never notices', async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => substrate() }));
    vi.stubGlobal('fetch', spy);
    await fetchPlanningSubstrate();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/planning/substrate');
    expect(init.cache).toBe('no-store');
  });

  it.each([
    ['a non-OK status', () => ({ ok: false, json: async () => ({}) })],
    [
      'a throwing request',
      () => {
        throw new Error('offline');
      },
    ],
    ['a body that is not an object', () => ({ ok: true, json: async () => 'nope' })],
    ['a body missing repositories', () => ({ ok: true, json: async () => ({ itemCount: 1 }) })],
    ['a body missing itemCount', () => ({ ok: true, json: async () => ({ repositories: [] }) })],
  ])('answers null on %s — never a throw, never a guess', async (_label, impl) => {
    stubFetch(impl as () => unknown);
    await expect(fetchPlanningSubstrate()).resolves.toBeNull();
  });
});

describe('anyRepositoryIndexed — a question of FACT, with no judgement in it', () => {
  it('is false for null, for an empty set, and while nothing has a graph', () => {
    expect(anyRepositoryIndexed(null)).toBe(false);
    expect(anyRepositoryIndexed(substrate({ repositories: [] }))).toBe(false);
    expect(anyRepositoryIndexed(substrate())).toBe(false);
  });

  it('is true once ANY repository has one — the same derivation the read uses', () => {
    // ⚠️ ANY, NOT ALL, and it mirrors `readOnboardingSubstrate`'s own
    // `repositoryIndexed`: one readable repository is enough for the verdict to
    // be ASKED again, and asking it is what decides whether that is ENOUGH.
    expect(
      anyRepositoryIndexed(
        substrate({
          repositories: [
            { ref: 'acme/widgets', indexed: false },
            { ref: 'acme/api', indexed: true },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('the two numbers say what they are for', () => {
  it('the ceiling is a bound on the PROMISE, not on the index', () => {
    // The job keeps running whatever this says; what expires is the window's
    // claim that it is about to finish. So it is far longer than one interval
    // and short enough that a spinner stops pretending to be information.
    expect(SUBSTRATE_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(SUBSTRATE_POLL_CEILING_MS).toBeGreaterThan(SUBSTRATE_POLL_INTERVAL_MS * 20);
  });
});
