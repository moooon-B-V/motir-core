import { describe, expect, it } from 'vitest';
import { normalizeRepoName, repoNameKey } from '@/lib/workItems/repoName';
import { normalizeTargetRepo } from '@/lib/workItems/targetRepo';

// MOTIR-3036 — the ONE definition of "the same repository", extracted so a
// CLIENT component can share it with the server module that has always owned it.
//
// The property this file defends is the SHARING. Three tables write a repository
// name and two of them write different forms of it (`work_item.targetRepos` and
// `github_repo.name` are bare; `LinkedPullRequestDto.repo` is `owner/name`), so
// a second copy of this rule is not a duplication that merely costs maintenance
// — it is how the Development section came to compare `motir-core` against
// `moooon-B-V/motir-core` and conclude the repository had no pull request.

describe('normalizeRepoName', () => {
  it('returns a bare name unchanged', () => {
    expect(normalizeRepoName('motir-core')).toBe('motir-core');
  });

  it('takes the NAME half of the owner/name ref form', () => {
    expect(normalizeRepoName('moooon-B-V/motir-core')).toBe('motir-core');
  });

  it('trims, on both sides of the slash', () => {
    expect(normalizeRepoName('  moooon / motir-core  ')).toBe('motir-core');
  });

  it('reads a blank value as NO repository, not as a repository named ""', () => {
    expect(normalizeRepoName('   ')).toBeNull();
    expect(normalizeRepoName('moooon/')).toBeNull();
    expect(normalizeRepoName(null)).toBeNull();
    expect(normalizeRepoName(undefined)).toBeNull();
  });

  it('preserves CASE — the stored value is the host’s own spelling', () => {
    expect(normalizeRepoName('MOTIR-Core')).toBe('MOTIR-Core');
  });
});

describe('repoNameKey', () => {
  it('case-folds, because a git host does', () => {
    expect(repoNameKey('moooon-B-V/MOTIR-CORE')).toBe(repoNameKey('motir-core'));
  });

  it('is NULL for an absent name, so two absences are never "the same repository"', () => {
    expect(repoNameKey(null)).toBeNull();
    expect(repoNameKey('')).toBeNull();
  });

  it('separates two genuinely different repositories', () => {
    expect(repoNameKey('moooon/motir-core')).not.toBe(repoNameKey('moooon/motir-ai'));
  });
});

describe('normalizeTargetRepo is the SAME rule, not a copy of it', () => {
  // The pin path and the delivery cross-reference must agree on repository
  // identity or a card's repository means one thing when it is pinned and
  // another when its pull requests are matched against it.
  it.each(['motir-core', 'moooon-B-V/motir-core', '  moooon / motir-core  ', 'moooon/', '', null])(
    'agrees on %o',
    (value) => {
      expect(normalizeTargetRepo(value)).toBe(normalizeRepoName(value));
    },
  );
});
