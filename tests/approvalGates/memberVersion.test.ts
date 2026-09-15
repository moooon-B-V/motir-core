import { describe, expect, it } from 'vitest';
import { membersOf, parseMemberVersion } from '@/lib/approvalGates/memberVersion';

// READING A MEMBER BACK OUT OF AN APPROVE-AND-MERGE SET'S VERSION (Story MOTIR-4909 ·
// MOTIR-5484/5486). The frame names every member from this, so a member spelled any other
// way must be skipped rather than guessed at — a guessed repository would put a pull request
// on screen that the approval never named.

describe('parseMemberVersion', () => {
  it('reads `owner/name#number@headSha`, keeping the spelling it was handed', () => {
    expect(parseMemberVersion('moooon/motir-core#131@3f2a91c0')).toEqual({
      subjectVersion: 'moooon/motir-core#131@3f2a91c0',
      repo: 'moooon/motir-core',
      number: 131,
      headSha: '3f2a91c0',
    });
  });

  it.each([
    ['no head', 'moooon/motir-core#131'],
    ['an empty head', 'moooon/motir-core#131@'],
    ['no number', 'moooon/motir-core@3f2a91c0'],
    ['a head where the repository should be', '@3f2a91c0'],
    ['no repository', '#131@3f2a91c0'],
    ['a number that is not one', 'moooon/motir-core#abc@3f2a91c0'],
    ['a zero number', 'moooon/motir-core#0@3f2a91c0'],
    ['a fractional number', 'moooon/motir-core#1.5@3f2a91c0'],
  ])('refuses %s', (_label, version) => {
    expect(parseMemberVersion(version)).toBeNull();
  });
});

describe('membersOf', () => {
  it('reads every member in the set’s own order, and skips a malformed one', () => {
    expect(
      membersOf('moooon/a#1@aa,not-a-member,moooon/b#2@bb').map((m) => [m.repo, m.number]),
    ).toEqual([
      ['moooon/a', 1],
      ['moooon/b', 2],
    ]);
  });

  it('is an empty set for a null or empty version', () => {
    expect(membersOf(null)).toEqual([]);
    expect(membersOf('')).toEqual([]);
  });
});
