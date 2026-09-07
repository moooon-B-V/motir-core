import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { needsDriftRecompute, resolveDriftCount } from '@/lib/codeGraph/driftCount';

// THE DRIFT COUNT (Story MOTIR-1754 · MOTIR-4644) — the producer of the number
// three surfaces already render, and the rule that decides when a stored one may
// be served.
//
// ⚠️ THE PROPERTY UNDER TEST IS NOT "THE COUNT IS RIGHT". It is that a count is
// only ever shown for the PAIR it was computed for, and that every other
// situation renders as `null` rather than as `0`. Zero means the graph MATCHES
// the head to every consumer, so the failure this file guards is not an
// off-by-one — it is the most reassuring possible answer appearing on the least
// evidence.

describe('resolveDriftCount — a count is a fact about a PAIR', () => {
  const pair = {
    indexedHeadSha: 'base1',
    defaultBranchHeadSha: 'head9',
  };

  it('serves the stored count when it belongs to the row’s CURRENT pair', () => {
    expect(
      resolveDriftCount({
        ...pair,
        commitsBehind: 40,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBe(40);
  });

  it('serves ZERO when that is what was actually counted', () => {
    // A real, measured zero is a legitimate answer and must survive: it is the
    // difference between "the graph matches" and "nobody counted", which is the
    // whole distinction this module exists to preserve.
    expect(
      resolveDriftCount({
        ...pair,
        commitsBehind: 0,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBe(0);
  });

  it('returns null when NOBODY has counted', () => {
    expect(
      resolveDriftCount({
        ...pair,
        commitsBehind: null,
        commitsBehindBaseSha: null,
        commitsBehindHeadSha: null,
      }),
    ).toBeNull();
  });

  it('returns null when a PUSH moved the head under the stored count', () => {
    // The count was true of `head9`; the branch is at `head10` now. The stored
    // number is a true statement about a pair that no longer exists, and it
    // renders identically to a current one — which is why it must not be served.
    expect(
      resolveDriftCount({
        indexedHeadSha: 'base1',
        defaultBranchHeadSha: 'head10',
        commitsBehind: 40,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBeNull();
  });

  it('returns null when an INDEX RUN moved the base under the stored count', () => {
    // The other half of the pair moves too, and it moves for a different reason
    // — a re-index rather than a push. Both invalidate the number.
    expect(
      resolveDriftCount({
        indexedHeadSha: 'base2',
        defaultBranchHeadSha: 'head9',
        commitsBehind: 40,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBeNull();
  });

  it('returns null when EITHER live sha is unknown, even if a count is stored', () => {
    // ⚠️ TWO NULLS ARE NOT A MATCH. `deriveCodeGraphIndexState` makes the same
    // call about the same two columns: a missing comparand is NOT KNOWN YET,
    // never "equal". Treating them as equal here would serve a count for a pair
    // nobody has observed.
    expect(
      resolveDriftCount({
        indexedHeadSha: null,
        defaultBranchHeadSha: 'head9',
        commitsBehind: 40,
        commitsBehindBaseSha: null,
        commitsBehindHeadSha: 'head9',
      }),
    ).toBeNull();
    expect(
      resolveDriftCount({
        indexedHeadSha: 'base1',
        defaultBranchHeadSha: null,
        commitsBehind: 40,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: null,
      }),
    ).toBeNull();
  });
});

describe('needsDriftRecompute — the sweep’s selection, beside the read’s rule', () => {
  it('is TRUE exactly when a real count is missing for a differing pair', () => {
    expect(
      needsDriftRecompute({
        indexedHeadSha: 'base1',
        defaultBranchHeadSha: 'head9',
        commitsBehind: null,
        commitsBehindBaseSha: null,
        commitsBehindHeadSha: null,
      }),
    ).toBe(true);
  });

  it('is FALSE when the shas MATCH — there is nothing to count', () => {
    // A matching pair is `indexed`. Counting it would spend a provider call to
    // learn zero, on every repository that is up to date, for ever.
    expect(
      needsDriftRecompute({
        indexedHeadSha: 'same',
        defaultBranchHeadSha: 'same',
        commitsBehind: null,
        commitsBehindBaseSha: null,
        commitsBehindHeadSha: null,
      }),
    ).toBe(false);
  });

  it('is FALSE when either sha is unknown — there is nothing to compare', () => {
    expect(
      needsDriftRecompute({
        indexedHeadSha: null,
        defaultBranchHeadSha: 'head9',
        commitsBehind: null,
        commitsBehindBaseSha: null,
        commitsBehindHeadSha: null,
      }),
    ).toBe(false);
  });

  it('is FALSE once the pair HAS been counted', () => {
    expect(
      needsDriftRecompute({
        indexedHeadSha: 'base1',
        defaultBranchHeadSha: 'head9',
        commitsBehind: 40,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBe(false);
  });

  it('⚠️ is FALSE for a pair that was TRIED and came back INDETERMINABLE', () => {
    // The case that makes this a pair test rather than a count test. A
    // force-pushed repository has no common ancestor, so `null` is its honest and
    // PERMANENT answer until a sha moves. Selecting on the count's nullness would
    // re-select it on every tick, spend a provider call to learn the same thing,
    // and write the same null — an infinite retry that looks like a working sweep
    // and surfaces only as a rate-limit bill.
    expect(
      needsDriftRecompute({
        indexedHeadSha: 'base1',
        defaultBranchHeadSha: 'head9',
        commitsBehind: null,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBe(false);
    // …and the READ still answers null for it, which is the one case where the
    // two functions deliberately disagree: tried, and not determinable.
    expect(
      resolveDriftCount({
        indexedHeadSha: 'base1',
        defaultBranchHeadSha: 'head9',
        commitsBehind: null,
        commitsBehindBaseSha: 'base1',
        commitsBehindHeadSha: 'head9',
      }),
    ).toBeNull();
  });

  it('⚠️ the sweep selects exactly the COMPARABLE rows whose stored PAIR has moved', () => {
    // The invariant that keeps the two rules from drifting apart. Note what it is
    // NOT: "everything the read calls null". A tried-and-indeterminable pair is
    // null to the read and must NOT be re-selected — that gap is deliberate, and
    // stating the invariant on the PAIR is what makes it visible.
    const shas = [null, 'a', 'b'] as const;
    const stored = [null, 'a', 'b'] as const;
    for (const indexedHeadSha of shas)
      for (const defaultBranchHeadSha of shas)
        for (const commitsBehindBaseSha of stored)
          for (const commitsBehindHeadSha of stored)
            for (const commitsBehind of [null, 7]) {
              const facts = {
                indexedHeadSha,
                defaultBranchHeadSha,
                commitsBehind,
                commitsBehindBaseSha,
                commitsBehindHeadSha,
              };
              const comparable =
                indexedHeadSha !== null &&
                defaultBranchHeadSha !== null &&
                indexedHeadSha !== defaultBranchHeadSha;
              const pairMoved =
                commitsBehindBaseSha !== indexedHeadSha ||
                commitsBehindHeadSha !== defaultBranchHeadSha;
              expect(needsDriftRecompute(facts)).toBe(comparable && pairMoved);
              // And nothing the sweep selects can already have a servable count:
              // a moved pair is exactly what the read refuses.
              if (needsDriftRecompute(facts)) expect(resolveDriftCount(facts)).toBeNull();
            }
  });
});

describe('the PROVIDER SEAM — both hosts back the comparison, and null is never zero', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function githubProvider() {
    vi.doMock('@/lib/github/appAuth', () => ({
      mintInstallationToken: async () => ({ token: 'tok' }),
      createAppJwt: () => 'jwt',
    }));
    const { getGitProvider } = await import('@/lib/git');
    await import('@/lib/git/providers/github');
    return getGitProvider('github');
  }

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    } as unknown as Response;
  }

  it('GitHub returns `behind_by` for a real pair', async () => {
    const provider = await githubProvider();
    fetchMock.mockResolvedValue(jsonResponse(200, { behind_by: 312, ahead_by: 0 }));
    await expect(provider.compareCommits('inst', 'acme', 'web', 'base', 'head')).resolves.toEqual({
      behindBy: 312,
    });
  });

  it('⚠️ a 404 is NO COMMON ANCESTOR — null, never 0', async () => {
    // A force-push or a rewritten history leaves the indexed sha unreachable
    // from the head. GitHub answers 404, and the count is UNDEFINED for that
    // pair. Zero would say "your graph matches your code".
    const provider = await githubProvider();
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'Not Found' }));
    const result = await provider.compareCommits('inst', 'acme', 'web', 'base', 'head');
    expect(result.behindBy).toBeNull();
    expect(result.behindBy).not.toBe(0);
    expect(result.reason).toBe('no_common_ancestor');
  });

  it('a host failure is null and is NOT thrown into the caller', async () => {
    const provider = await githubProvider();
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    await expect(
      provider.compareCommits('inst', 'acme', 'web', 'base', 'head'),
    ).resolves.toMatchObject({ behindBy: null, reason: 'unreachable' });
  });

  it('a network throw is null, not a rejection', async () => {
    const provider = await githubProvider();
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      provider.compareCommits('inst', 'acme', 'web', 'base', 'head'),
    ).resolves.toMatchObject({ behindBy: null, reason: 'unreachable' });
  });

  it('⚠️ a non-numeric `behind_by` is null — NOT coerced', async () => {
    // `Number(undefined)` is NaN and `Number(null)` is 0. The second is the one
    // answer this must never invent, so the guard is a type check rather than a
    // cast.
    const provider = await githubProvider();
    fetchMock.mockResolvedValue(jsonResponse(200, { ahead_by: 3 }));
    await expect(
      provider.compareCommits('inst', 'acme', 'web', 'base', 'head'),
    ).resolves.toMatchObject({ behindBy: null, reason: 'inexact' });
  });
});
