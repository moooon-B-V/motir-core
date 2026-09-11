import { describe, expect, it } from 'vitest';
import { parsePullRequestReference } from '@/lib/github/prReferenceQuery';

// MOTIR-5150 — the picker's grammar gains a PR-REFERENCE form.
//
// The defect this covers is not a wrong answer, it is an absent one: the four
// `contains` clauses ask whether a COLUMN contains the query, so the only thing
// somebody linking a pull request actually holds — its URL — matched nothing at
// all. These are the forms a person reaches for, and the negatives are the ones
// that must NOT be read as coordinates, because every false positive here turns
// an ordinary free-text search into an exact match that finds nothing.

describe('parsePullRequestReference — the four forms a person pastes', () => {
  it('reads a full pull-request URL', () => {
    expect(parsePullRequestReference('https://github.com/moooon-B-V/motir-ai/pull/466')).toEqual({
      owner: 'moooon-B-V',
      name: 'motir-ai',
      number: 466,
    });
  });

  it('reads a URL whatever GitHub appended to it', () => {
    // These are what the address bar actually holds when somebody copies it
    // from a review, a file view or a comment anchor.
    for (const suffix of ['/files', '/commits/abc123', '?w=1', '#discussion_r12345', '/']) {
      expect(
        parsePullRequestReference(`https://github.com/moooon-B-V/motir-ai/pull/466${suffix}`),
        suffix,
      ).toEqual({ owner: 'moooon-B-V', name: 'motir-ai', number: 466 });
    }
  });

  it('reads a URL on a host that is not github.com (GitHub Enterprise)', () => {
    expect(parsePullRequestReference('https://git.example.org/acme/web/pull/12')).toEqual({
      owner: 'acme',
      name: 'web',
      number: 12,
    });
  });

  it('reads owner/name#n', () => {
    expect(parsePullRequestReference('moooon-B-V/motir-ai#466')).toEqual({
      owner: 'moooon-B-V',
      name: 'motir-ai',
      number: 466,
    });
  });

  it('reads name#n', () => {
    expect(parsePullRequestReference('motir-ai#466')).toEqual({ name: 'motir-ai', number: 466 });
  });

  it('reads #n', () => {
    expect(parsePullRequestReference('#466')).toEqual({ number: 466 });
  });

  it('trims surrounding whitespace, which a paste carries', () => {
    expect(parsePullRequestReference('  #466\n')).toEqual({ number: 466 });
  });

  it('admits a repo name with dots and underscores', () => {
    expect(parsePullRequestReference('acme/my_repo.js#7')).toEqual({
      owner: 'acme',
      name: 'my_repo.js',
      number: 7,
    });
  });
});

describe('parsePullRequestReference — what stays FREE TEXT', () => {
  it.each([
    ['', 'the empty query'],
    ['466', 'a bare number — the existing clause owns it, and it is not a coordinate'],
    ['rate limit', 'ordinary words'],
    ['fix the #hashtag copy', 'a hash inside a sentence'],
    ['#', 'a lone hash'],
    ['#0', 'pull request zero does not exist'],
    ['#0466', 'a leading-zero form GitHub never renders'],
    ['#12.5', 'not an integer'],
    ['#-3', 'not a positive integer'],
    // The same rejection reached through each of the other three forms, so no
    // form has a path to a number the `#n` form would refuse.
    ['https://github.com/acme/web/pull/0', 'pull request zero, by URL'],
    ['acme/web#0', 'pull request zero, by owner/name#n'],
    ['web#0', 'pull request zero, by name#n'],
    ['https://github.com/moooon-B-V/motir-ai/issues/466', 'an ISSUE is not a pull request'],
    ['https://github.com/moooon-B-V/motir-ai', 'a repository URL names no pull request'],
    ['https://github.com/pull/466', 'no owner and name to key on'],
    ['-acme/web#1', 'an owner may not start with a hyphen'],
    ['a/b/c#1', 'three segments is not owner/name'],
    [`#${'9'.repeat(10)}`, 'more digits than any pull-request number has'],
  ])('%s is not a reference (%s)', (query) => {
    expect(parsePullRequestReference(query)).toBeNull();
  });
});
