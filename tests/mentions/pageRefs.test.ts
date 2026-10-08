import { describe, expect, it } from 'vitest';
import {
  PAGE_HREF_RE,
  formatPageToken,
  parsePageTokenIds,
  relabelPageTokens,
} from '@/lib/mentions/pageRefs';

// The `motir-page:` token grammar (Story MOTIR-7694 · MOTIR-7696).

describe('parsePageTokenIds', () => {
  it('returns each tagged page once, in body order', () => {
    const md = 'See [Spec](motir-page:p1), [Notes](motir-page:p2) and [Spec again](motir-page:p1).';
    expect(parsePageTokenIds(md)).toEqual(['p1', 'p2']);
  });

  it('ignores work-item and mention tokens, and malformed near-tokens', () => {
    const md = [
      '[MOTIR-1](motir:w1)',
      '[@Mo](mention:u1)',
      '[no scheme](p3)',
      '[unclosed(motir-page:p4)',
      '[](motir-page:)',
    ].join(' ');
    expect(parsePageTokenIds(md)).toEqual([]);
  });

  it('answers nothing for an empty or missing body', () => {
    expect(parsePageTokenIds('')).toEqual([]);
    expect(parsePageTokenIds(null)).toEqual([]);
    expect(parsePageTokenIds(undefined)).toEqual([]);
  });
});

describe('formatPageToken', () => {
  it('round-trips through the parser', () => {
    const token = formatPageToken('cmpage123', 'Launch plan');
    expect(token).toBe('[Launch plan](motir-page:cmpage123)');
    expect(parsePageTokenIds(`a ${token} b`)).toEqual(['cmpage123']);
  });

  it('drops brackets from the label and never leaves it empty', () => {
    expect(formatPageToken('p1', '[Draft] plan')).toBe('[Draft plan](motir-page:p1)');
    expect(formatPageToken('p1', ' [] ')).toBe('[page](motir-page:p1)');
  });
});

describe('PAGE_HREF_RE', () => {
  it('matches only a well-formed page href', () => {
    expect(PAGE_HREF_RE.exec('motir-page:abc_1-2')?.[1]).toBe('abc_1-2');
    expect(PAGE_HREF_RE.test('motir:abc')).toBe(false);
    expect(PAGE_HREF_RE.test('motir-page:')).toBe(false);
    expect(PAGE_HREF_RE.test('https://x/motir-page:a')).toBe(false);
  });
});

describe('relabelPageTokens', () => {
  it('rewrites only page-token labels and keeps the id', () => {
    const md = 'A [Secret](motir-page:p1) and [MOTIR-1](motir:w1).';
    expect(relabelPageTokens(md, () => 'Page')).toBe(
      'A [Page](motir-page:p1) and [MOTIR-1](motir:w1).',
    );
  });
});
