import { describe, expect, it } from 'vitest';
import {
  WORKITEM_TOKEN_RE,
  WORKITEM_HREF_RE,
  buildWorkItemKeyRe,
  parseWorkItemTokenIds,
  parseWorkItemKeys,
  parseWorkItemRefs,
} from '@/lib/mentions/workItemRefs';

// Pure unit tests for the work-item reference parser (Story 5.8 · Subtask
// 5.8.2) — the parallel of the user-mention parser (parse.ts). No DB.

describe('parseWorkItemTokenIds', () => {
  it('extracts the id from a motir: token', () => {
    const ids = parseWorkItemTokenIds('See [MOTIR-805](motir:cltabc123) for the engine.');
    expect(ids).toEqual(['cltabc123']);
  });

  it('dedupes repeated ids in first-seen order', () => {
    const body =
      'Blocks [MOTIR-1](motir:idB) then [MOTIR-2](motir:idA) and again [MOTIR-1](motir:idB).';
    expect(parseWorkItemTokenIds(body)).toEqual(['idB', 'idA']);
  });

  it('ignores malformed near-tokens (no scheme, unclosed bracket)', () => {
    expect(
      parseWorkItemTokenIds('[MOTIR-1](https://x) and [MOTIR-2](motir:) and [a(motir:b)'),
    ).toEqual([]);
  });

  it('returns [] for an empty body', () => {
    expect(parseWorkItemTokenIds('')).toEqual([]);
  });
});

describe('parseWorkItemKeys', () => {
  it('extracts a bare project key', () => {
    expect(parseWorkItemKeys('Depends on MOTIR-11 to ship.', 'MOTIR')).toEqual(['MOTIR-11']);
  });

  it('canonicalises a lower-case prefix and dedupes', () => {
    expect(parseWorkItemKeys('motir-11 and MOTIR-11 and motir-12', 'MOTIR')).toEqual([
      'MOTIR-11',
      'MOTIR-12',
    ]);
  });

  it('only matches THIS project prefix (a foreign key is plain text)', () => {
    expect(parseWorkItemKeys('See OTHER-9 and MOTIR-9', 'MOTIR')).toEqual(['MOTIR-9']);
  });

  it('word-boundaried — does not match a key glued into a longer token', () => {
    expect(parseWorkItemKeys('XMOTIR-9 and MOTIR-9X are not keys', 'MOTIR')).toEqual([]);
  });

  it('escapes a regex-special prefix safely', () => {
    expect(buildWorkItemKeyRe('A.B').test('A.B-3')).toBe(true);
    expect(buildWorkItemKeyRe('A.B').test('AxB-3')).toBe(false);
  });
});

describe('parseWorkItemRefs', () => {
  it('returns both token ids and bare keys, each deduped first-seen', () => {
    const body = 'This [MOTIR-805](motir:cltX) blocks MOTIR-11 and also MOTIR-11 again.';
    expect(parseWorkItemRefs(body, 'MOTIR')).toEqual({ ids: ['cltX'], keys: ['MOTIR-11'] });
  });
});

describe('WORKITEM_HREF_RE', () => {
  it('accepts a well-formed motir href and rejects a malformed one', () => {
    expect(WORKITEM_HREF_RE.test('motir:cltabc123')).toBe(true);
    expect(WORKITEM_HREF_RE.test('motir:')).toBe(false);
    expect(WORKITEM_HREF_RE.test('mention:cltabc123')).toBe(false);
  });

  it('WORKITEM_TOKEN_RE carries no lastIndex state across calls', () => {
    const body = '[K](motir:a) [K](motir:b)';
    expect(parseWorkItemTokenIds(body)).toEqual(['a', 'b']);
    expect(parseWorkItemTokenIds(body)).toEqual(['a', 'b']);
    expect(WORKITEM_TOKEN_RE.lastIndex).toBe(0);
  });
});
