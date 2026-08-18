import { describe, expect, it } from 'vitest';
import {
  matchAuthoredTargetRepo,
  matchAuthoredTargetRepos,
  primaryTargetRepo,
  resolveDispatchRepo,
  type ConnectedRepoName,
} from '@/lib/workItems/targetRepo';
import { UnknownTargetRepoError } from '@/lib/workItems/errors';

// The repository SET's POLICY, unit-tested without a work item (Story MOTIR-2725 ·
// MOTIR-2727, ADR `docs/decisions/work-item-repository-set.md` §1).
//
// `matchAuthoredTargetRepos` is a thin list wrapper over the shipped
// `matchAuthoredTargetRepo`, and that is the property most of this file defends:
// the set path and the single path must normalize, case-fold and reject
// identically, or a card's repository means one thing when it was pinned and
// another when it was listed. Everything else here is list semantics the single
// path has no opinion about — order, duplicates, blanks, and where validation
// stops.

const DOMAIN: ConnectedRepoName[] = [
  {
    name: 'motir-core',
    repoRef: 'moooon/motir-core',
    cloneUrl: 'https://github.com/moooon/motir-core.git',
    defaultBranch: 'main',
    archived: false,
  },
  {
    name: 'motir-ai',
    repoRef: 'moooon/motir-ai',
    cloneUrl: 'https://github.com/moooon/motir-ai.git',
    defaultBranch: 'trunk',
    archived: false,
  },
  {
    name: 'motir-gateway',
    repoRef: 'moooon/motir-gateway',
    cloneUrl: null,
    defaultBranch: null,
    archived: false,
  },
];

describe('matchAuthoredTargetRepos — the SET, validated element by element', () => {
  it('preserves the authored ORDER, because element 0 is the primary dispatch routes to', () => {
    expect(matchAuthoredTargetRepos(['motir-ai', 'motir-core'], DOMAIN)).toEqual([
      'motir-ai',
      'motir-core',
    ]);
    // The same two repositories the other way round is a DIFFERENT decision, not
    // the same set — nothing sorts.
    expect(matchAuthoredTargetRepos(['motir-core', 'motir-ai'], DOMAIN)).toEqual([
      'motir-core',
      'motir-ai',
    ]);
  });

  it('accepts the `owner/name` ref form in a list, identically to a single pin', () => {
    expect(matchAuthoredTargetRepos(['moooon/motir-core', 'motir-ai'], DOMAIN)).toEqual([
      'motir-core',
      'motir-ai',
    ]);
    // The shared-policy claim, asserted rather than assumed: every element goes
    // through the same function one pin does, so the two can never disagree.
    for (const authored of ['moooon/motir-core', 'MOTIR-CORE', ' motir-core ']) {
      expect(matchAuthoredTargetRepos([authored], DOMAIN)).toEqual([
        matchAuthoredTargetRepo(authored, DOMAIN),
      ]);
    }
  });

  it("stores the DOMAIN repo's own casing, so the column and .motir.json agree", () => {
    expect(matchAuthoredTargetRepos(['MOTIR-CORE', 'Motir-AI'], DOMAIN)).toEqual([
      'motir-core',
      'motir-ai',
    ]);
  });

  it('collapses duplicates on the MATCHED name, keeping the first occurrence', () => {
    // Three spellings of one repository are ONE element — the dedupe compares
    // what the domain matched, not what the author typed, so a set cannot carry
    // the same checkout three times under three names.
    expect(
      matchAuthoredTargetRepos(
        ['motir-core', 'MOTIR-CORE', 'moooon/motir-core', 'motir-ai'],
        DOMAIN,
      ),
    ).toEqual(['motir-core', 'motir-ai']);
  });

  it('keeps the FIRST occurrence, which is what makes dedupe order-preserving', () => {
    // If dedupe kept the LAST occurrence, this would return ['motir-core',
    // 'motir-ai'] and the primary would silently move.
    expect(matchAuthoredTargetRepos(['motir-ai', 'motir-core', 'motir-ai'], DOMAIN)).toEqual([
      'motir-ai',
      'motir-core',
    ]);
  });

  it('drops blank elements rather than treating "" as a repository name', () => {
    expect(matchAuthoredTargetRepos(['motir-core', '', '   ', null, undefined], DOMAIN)).toEqual([
      'motir-core',
    ]);
  });

  it('treats [], null and undefined as the SAME empty set', () => {
    expect(matchAuthoredTargetRepos([], DOMAIN)).toEqual([]);
    expect(matchAuthoredTargetRepos(null, DOMAIN)).toEqual([]);
    expect(matchAuthoredTargetRepos(undefined, DOMAIN)).toEqual([]);
    expect(matchAuthoredTargetRepos(['', '  '], DOMAIN)).toEqual([]);
  });

  it('throws the shipped UnknownTargetRepoError on the FIRST unknown element, naming the known set', () => {
    expect(() => matchAuthoredTargetRepos(['motir-core', 'motir-typo'], DOMAIN)).toThrow(
      UnknownTargetRepoError,
    );
    try {
      matchAuthoredTargetRepos(['motir-core', 'motir-typo', 'also-wrong'], DOMAIN);
      expect.unreachable('an unknown element must reject the whole write');
    } catch (err) {
      // The message names the offending element and the domain — the same message
      // a single unknown pin produces, because it IS the same error.
      expect((err as Error).message).toContain('motir-typo');
      expect((err as Error).message).toContain('moooon/motir-core');
      expect((err as Error).message).not.toContain('also-wrong');
    }
  });

  it('is ALL-OR-NOTHING — a partially valid list stores nothing', () => {
    // The alternative (drop the unknown, keep the rest) would store a repository
    // list the author never wrote, and it would do it silently.
    expect(() => matchAuthoredTargetRepos(['motir-typo', 'motir-core'], DOMAIN)).toThrow(
      UnknownTargetRepoError,
    );
  });

  it("uses the PROJECT scope's wording when told to, exactly as the single path does", () => {
    try {
      matchAuthoredTargetRepos(['nope'], DOMAIN, 'project');
      expect.unreachable('unknown element');
    } catch (err) {
      expect((err as Error).message).toContain("This project's repositories");
    }
  });
});

describe('primaryTargetRepo — the one definition of the derived scalar', () => {
  it('is element 0, or null for the empty set', () => {
    expect(primaryTargetRepo(['motir-ai', 'motir-core'])).toBe('motir-ai');
    expect(primaryTargetRepo(['motir-core'])).toBe('motir-core');
    expect(primaryTargetRepo([])).toBeNull();
  });

  it('agrees with what dispatch resolves for that set — the scalar IS the routing decision', () => {
    const set = matchAuthoredTargetRepos(['motir-ai', 'motir-core'], DOMAIN);
    expect(resolveDispatchRepo(primaryTargetRepo(set), DOMAIN)?.name).toBe('motir-ai');
  });
});

describe('dispatch is UNCHANGED by the set — asserted, not inferred (ADR §2)', () => {
  it('resolves an N-repo card to its primary, with that repo’s own coordinates', () => {
    const set = matchAuthoredTargetRepos(['motir-ai', 'motir-core'], DOMAIN);
    expect(resolveDispatchRepo(primaryTargetRepo(set), DOMAIN)).toEqual({
      name: 'motir-ai',
      cloneUrl: 'https://github.com/moooon/motir-ai.git',
      // `trunk`, not `main` — the mirrored default branch, never a hard-coded
      // guess. The completion gate (MOTIR-2729) compares against this same value.
      defaultBranch: 'trunk',
    });
  });

  it('resolves a ONE-repo card exactly as the shipped single pin did', () => {
    const viaSet = resolveDispatchRepo(
      primaryTargetRepo(matchAuthoredTargetRepos(['motir-core'], DOMAIN)),
      DOMAIN,
    );
    const viaPin = resolveDispatchRepo(matchAuthoredTargetRepo('motir-core', DOMAIN), DOMAIN);
    expect(viaSet).toEqual(viaPin);
  });

  it('still refuses to GUESS for an empty set against a multi-repo domain', () => {
    // The empty set is the old null pin, and rung 3 is unchanged: with two or
    // more repositories and nothing pinned, Motir says "I do not know".
    expect(resolveDispatchRepo(primaryTargetRepo([]), DOMAIN)).toBeNull();
  });

  it('still falls back to the domain’s SINGLE repo for an empty set', () => {
    const only = [DOMAIN[0]!];
    expect(resolveDispatchRepo(primaryTargetRepo([]), only)?.name).toBe('motir-core');
  });
});
