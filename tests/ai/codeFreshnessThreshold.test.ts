import { describe, expect, it } from 'vitest';
import {
  BADLY_STALE_COMMITS_BEHIND,
  codeBlindPauseReason,
  isBadlyStale,
} from '@/lib/ai/codeFreshness';
import type { CodeContextDTO } from '@/lib/dto/codeContext';

// THE ONE THRESHOLD (Story MOTIR-1754 · MOTIR-4603) — "badly behind", defined
// once and read by every consumer that decides whether Motir may still act on
// its own view of the code. One number, three consumers; a second definition is
// how the cadence and the surface come to disagree about the same project.

function ctx(over: Partial<CodeContextDTO> = {}): CodeContextDTO {
  return {
    hasCodeContext: true,
    repos: [],
    hasImplementedWork: false,
    freshnessUnavailable: false,
    ...over,
  };
}

function repo(commitsBehind: number | null) {
  return {
    repoRef: 'acme/web',
    provider: 'github',
    verdict: 'stale' as const,
    indexedCommitSha: 'a'.repeat(40),
    indexedAt: null,
    codegraphVersion: null,
    headSha: 'b'.repeat(40),
    commitsBehind,
  };
}

describe('isBadlyStale — a THRESHOLD, never "any drift"', () => {
  it('fires AT the threshold and above', () => {
    expect(isBadlyStale({ commitsBehind: BADLY_STALE_COMMITS_BEHIND })).toBe(true);
    expect(isBadlyStale({ commitsBehind: BADLY_STALE_COMMITS_BEHIND + 1 })).toBe(true);
    expect(isBadlyStale({ commitsBehind: 5000 })).toBe(true);
  });

  it('does NOT fire below it — an active repo is always a few commits behind', () => {
    // With push-driven refresh healthy (2-min debounce, 15-min cap) an active
    // repository sits a handful of commits behind between pushes. Pausing on any
    // drift would pause the cadence PERMANENTLY for exactly the projects doing
    // the most work — the inverse of what it is for.
    expect(isBadlyStale({ commitsBehind: 0 })).toBe(false);
    expect(isBadlyStale({ commitsBehind: 1 })).toBe(false);
    expect(isBadlyStale({ commitsBehind: BADLY_STALE_COMMITS_BEHIND - 1 })).toBe(false);
  });

  it('UNKNOWN drift is never "badly behind" — a pause on missing evidence is a false accusation', () => {
    // The same rule that makes a NULL head resolve to `current` rather than
    // `stale`. It is also the production state today: `commitsBehind` is always
    // null until its producer ships, so this arm is what actually runs.
    expect(isBadlyStale({ commitsBehind: null })).toBe(false);
  });
});

describe('codeBlindPauseReason — what makes Motir stop DECIDING', () => {
  it('no connected repo pauses', () => {
    expect(codeBlindPauseReason(ctx({ hasCodeContext: false }))).toBe('no_connected_repo');
  });

  it('a badly-stale repo pauses, and one below the threshold does not', () => {
    expect(codeBlindPauseReason(ctx({ repos: [repo(BADLY_STALE_COMMITS_BEHIND)] }))).toBe(
      'badly_stale_graph',
    );
    expect(codeBlindPauseReason(ctx({ repos: [repo(BADLY_STALE_COMMITS_BEHIND - 1)] }))).toBeNull();
  });

  it('ONE badly-stale repo in a set is enough — the planner reads them all', () => {
    expect(codeBlindPauseReason(ctx({ repos: [repo(1), repo(BADLY_STALE_COMMITS_BEHIND)] }))).toBe(
      'badly_stale_graph',
    );
  });

  it('an OLD graph on an unchanged repo does NOT pause — drift, never age', () => {
    // `commitsBehind: 0` with an ancient `indexedAt` is a graph that is exactly
    // right. An age-led threshold would pause this and let a two-hour-old graph
    // on a busy repo through — both backwards.
    const ancient = {
      ...repo(0),
      verdict: 'current' as const,
      indexedAt: '2024-01-01T00:00:00.000Z',
    };
    expect(codeBlindPauseReason(ctx({ repos: [ancient] }))).toBeNull();
  });

  it('a freshness read that DID NOT ANSWER does not pause', () => {
    // `freshnessUnavailable` means motir-ai could not be asked, which is not
    // evidence of drift. Pausing here would convert one service's downtime into
    // a silent, unexplained stop on every project that has a repository.
    expect(
      codeBlindPauseReason(
        ctx({ freshnessUnavailable: true, repos: [repo(BADLY_STALE_COMMITS_BEHIND * 10)] }),
      ),
    ).toBeNull();
  });

  it('a connected, current project does not pause', () => {
    expect(codeBlindPauseReason(ctx({ repos: [{ ...repo(0), verdict: 'current' }] }))).toBeNull();
  });
});
