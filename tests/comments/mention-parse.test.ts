import { describe, expect, it } from 'vitest';
import { parseMentionIds } from '@/lib/mentions/parse';

// Unit tests for the pure mention-token parser (Story 5.1 · Subtask 5.1.2) —
// `[@Display Name](mention:<userId>)` extraction, dedup, and the
// malformed-near-token cases (body text, never an error).

describe('parseMentionIds', () => {
  it('extracts the user id from a single token', () => {
    expect(parseMentionIds('Hi [@Bo Philips](mention:user_abc123)!')).toEqual(['user_abc123']);
  });

  it('extracts multiple ids in first-seen order', () => {
    const body = '[@A](mention:id-a) then [@B](mention:id-b) and [@C](mention:id-c)';
    expect(parseMentionIds(body)).toEqual(['id-a', 'id-b', 'id-c']);
  });

  it('dedups a repeated mention to one id', () => {
    const body = '[@A](mention:id-a) again [@A different label](mention:id-a) [@B](mention:id-b)';
    expect(parseMentionIds(body)).toEqual(['id-a', 'id-b']);
  });

  it('handles display names with spaces, dots, and an empty label', () => {
    expect(parseMentionIds('[@Zhu Yue Jr.](mention:cuid1) [@](mention:cuid2)')).toEqual([
      'cuid1',
      'cuid2',
    ]);
  });

  it('ignores malformed near-tokens', () => {
    const body = [
      'plain @name',
      '[@no-scheme](user_x)',
      '[@unclosed(mention:user_y)',
      '[link](mention:)', // no id
      '[@spaced](mention: user_z)', // space breaks the id charset
    ].join(' ');
    expect(parseMentionIds(body)).toEqual([]);
  });

  it('returns [] for an empty body', () => {
    expect(parseMentionIds('')).toEqual([]);
  });
});
