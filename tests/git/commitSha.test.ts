import { describe, expect, it } from 'vitest';
import { COMMIT_SHA_PATTERN, COMMIT_SHA_REFUSAL, normalizeCommitSha } from '@/lib/git/commitSha';

// The shared commit-id guard (MOTIR-5619) — the pattern and the normalisation
// that `acceptanceEvidenceService` and `testInstructionsService` both consume,
// so the doors on one card cannot refuse different things. Pure: no database,
// no network.

describe('normalizeCommitSha — accepts and NORMALISES', () => {
  it('passes a canonical abbreviated id through unchanged', () => {
    expect(normalizeCommitSha('832026b')).toEqual({ ok: true, commitSha: '832026b' });
  });

  it('passes a full 40-character SHA-1 through unchanged', () => {
    const sha = '832026b77b2b276ae9ba028b47e603274a4072cd';
    expect(normalizeCommitSha(sha)).toEqual({ ok: true, commitSha: sha });
  });

  it('accepts a 64-character SHA-256 id', () => {
    const sha = 'a'.repeat(64);
    expect(normalizeCommitSha(sha)).toEqual({ ok: true, commitSha: sha });
  });

  // THE SHELL-PIPELINE CASE, and the reason normalisation comes before
  // validation. A client building JSON from `$(git rev-parse HEAD)` without
  // stripping the newline sends this; it is a non-blank string, so an emptiness
  // check passes it, and under `===` it is a DIFFERENT idempotency key.
  it('strips the trailing newline a shell pipeline leaves', () => {
    expect(normalizeCommitSha('832026b77b2b276ae9ba028b47e603274a4072cd\n')).toEqual({
      ok: true,
      commitSha: '832026b77b2b276ae9ba028b47e603274a4072cd',
    });
  });

  it('strips surrounding whitespace', () => {
    expect(normalizeCommitSha('  abc1234  ')).toEqual({ ok: true, commitSha: 'abc1234' });
  });

  it('lower-cases upper-case hex', () => {
    expect(normalizeCommitSha('ABC123DEF')).toEqual({ ok: true, commitSha: 'abc123def' });
  });

  it('normalises whitespace AND case together, so one commit is one key', () => {
    const a = normalizeCommitSha('832026B7\n');
    const b = normalizeCommitSha('832026b7');
    expect(a).toEqual({ ok: true, commitSha: '832026b7' });
    expect(a).toEqual(b);
  });
});

describe('normalizeCommitSha — refuses', () => {
  // Each refusal carries the SAME reason string, which is what keeps
  // `publish_test_instructions`' existing message unchanged.
  it.each([
    ['a branch name', 'main'],
    ['HEAD', 'HEAD'],
    ['a placeholder', 'not-a-commit'],
    ['non-hex characters', 'seam001'],
    ['an id shorter than 7', 'abc123'],
    ['a single character', 'a'],
    ['an id longer than 64', 'a'.repeat(65)],
    ['the empty string', ''],
    ['whitespace only', '   '],
    ['an id with an interior space', 'abc 1234'],
    ['a decorated id', 'sha-overlay'],
  ])('refuses %s', (_label, input) => {
    expect(normalizeCommitSha(input)).toEqual({ ok: false, reason: COMMIT_SHA_REFUSAL });
  });

  // FORMAT IS NOT EXISTENCE, stated as a test so nobody reads the guard as a
  // stronger claim than it makes. This is the exact value that surfaced the
  // defect: a real short sha completed with invented characters, 40 valid hex
  // digits naming no commit in the repository.
  it('ACCEPTS 40 valid hex characters that name no commit — existence is out of scope', () => {
    expect(normalizeCommitSha('832026b775b1a9f0f2aa2e1bd1bbd4e8ba0ba0f9')).toEqual({
      ok: true,
      commitSha: '832026b775b1a9f0f2aa2e1bd1bbd4e8ba0ba0f9',
    });
  });
});

describe('COMMIT_SHA_PATTERN', () => {
  it('is the 7-to-64 lower-case hex pattern the two services share', () => {
    expect(COMMIT_SHA_PATTERN.source).toBe('^[0-9a-f]{7,64}$');
  });

  // The pattern rules on the NORMALISED form, so it is deliberately
  // case-sensitive — upper-case hex reaches it already lower-cased.
  it('does not itself accept upper-case hex — normalisation runs first', () => {
    expect(COMMIT_SHA_PATTERN.test('ABC1234')).toBe(false);
    expect(COMMIT_SHA_PATTERN.test('abc1234')).toBe(true);
  });
});
