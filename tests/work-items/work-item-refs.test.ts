import { describe, expect, it } from 'vitest';
import {
  WORKITEM_TOKEN_RE,
  WORKITEM_HREF_RE,
  buildWorkItemKeyRe,
  parseWorkItemTokenIds,
  parseWorkItemKeys,
  parseWorkItemRefs,
  normalizeWorkItemRefs,
  INTRA_PLAN_REF_TOKEN_RE,
  parseIntraPlanRefIds,
  rewriteIntraPlanRefs,
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

describe('normalizeWorkItemRefs (bug MOTIR-1440)', () => {
  const resolve = new Map([
    ['MOTIR-11', 'idEleven'],
    ['MOTIR-12', 'idTwelve'],
  ]);

  it('rewrites a bare key to the canonical token', () => {
    expect(normalizeWorkItemRefs('Depends on MOTIR-11 to ship.', 'MOTIR', resolve)).toBe(
      'Depends on [MOTIR-11](motir:idEleven) to ship.',
    );
  });

  it('canonicalises a lower-case bare key (label upper-cased)', () => {
    expect(normalizeWorkItemRefs('see motir-11', 'MOTIR', resolve)).toBe(
      'see [MOTIR-11](motir:idEleven)',
    );
  });

  it('leaves an unresolved key as plain text', () => {
    expect(normalizeWorkItemRefs('see MOTIR-999 here', 'MOTIR', resolve)).toBe(
      'see MOTIR-999 here',
    );
  });

  it('leaves an already-explicit token untouched (does not re-wrap its label key)', () => {
    const body = 'cf. [MOTIR-11](motir:idEleven) already.';
    expect(normalizeWorkItemRefs(body, 'MOTIR', resolve)).toBe(body);
  });

  it('is idempotent — normalising the result again is a no-op', () => {
    const once = normalizeWorkItemRefs('blocks MOTIR-11 and MOTIR-12', 'MOTIR', resolve);
    expect(normalizeWorkItemRefs(once, 'MOTIR', resolve)).toBe(once);
  });

  it('rewrites multiple distinct keys, each to its own token', () => {
    expect(normalizeWorkItemRefs('MOTIR-11 then MOTIR-12', 'MOTIR', resolve)).toBe(
      '[MOTIR-11](motir:idEleven) then [MOTIR-12](motir:idTwelve)',
    );
  });

  it('mixes a bare key (rewritten) beside an existing token (kept)', () => {
    expect(normalizeWorkItemRefs('MOTIR-11 and [MOTIR-12](motir:idTwelve)', 'MOTIR', resolve)).toBe(
      '[MOTIR-11](motir:idEleven) and [MOTIR-12](motir:idTwelve)',
    );
  });

  it('does not touch a foreign-project bare key', () => {
    expect(normalizeWorkItemRefs('see OTHER-11', 'MOTIR', resolve)).toBe('see OTHER-11');
  });

  it('returns the text unchanged for an empty resolve map', () => {
    expect(normalizeWorkItemRefs('see MOTIR-11', 'MOTIR', new Map())).toBe('see MOTIR-11');
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

describe('intra-plan item-link tokens (MOTIR-1418)', () => {
  // planItem id → created work-item id (the map materialize builds).
  const resolve = new Map([
    ['piA', 'wiA'],
    ['piB', 'wiB'],
  ]);

  it('rewrites ONLY the intra-plan token; an existing motir: token + a bare key pass through', () => {
    const body = 'See [A](motir-ref:planItem:piA), [B](motir:wiExisting), and MOTIR-11.';
    const { body: out, unresolved } = rewriteIntraPlanRefs(body, resolve);
    expect(out).toBe('See [A](motir:wiA), [B](motir:wiExisting), and MOTIR-11.');
    expect(unresolved).toEqual([]);
  });

  it('leaves a dangling temp-ref inert and reports its id (never a half-token/crash)', () => {
    const { body, unresolved } = rewriteIntraPlanRefs('[X](motir-ref:planItem:piGone)', resolve);
    expect(body).toBe('[X](motir-ref:planItem:piGone)'); // untouched
    expect(unresolved).toEqual(['piGone']);
  });

  it('preserves the label and rewrites multiple tokens', () => {
    const { body } = rewriteIntraPlanRefs(
      '[the schema](motir-ref:planItem:piA) then [the route](motir-ref:planItem:piB)',
      resolve,
    );
    expect(body).toBe('[the schema](motir:wiA) then [the route](motir:wiB)');
  });

  it('returns the body unchanged when there is no intra-plan token', () => {
    const body = 'plain text, a [k](motir:x) token and MOTIR-11';
    expect(rewriteIntraPlanRefs(body, resolve).body).toBe(body);
    expect(rewriteIntraPlanRefs(body, new Map()).body).toBe(body);
  });

  it('parseIntraPlanRefIds returns distinct planItem ids in first-seen order', () => {
    expect(
      parseIntraPlanRefIds(
        '[a](motir-ref:planItem:piA) [a2](motir-ref:planItem:piA) [b](motir-ref:planItem:piB)',
      ),
    ).toEqual(['piA', 'piB']);
  });

  it('INTRA_PLAN_REF_TOKEN_RE carries no lastIndex state across calls', () => {
    const body = '[a](motir-ref:planItem:piA)';
    expect(parseIntraPlanRefIds(body)).toEqual(['piA']);
    expect(parseIntraPlanRefIds(body)).toEqual(['piA']);
    expect(INTRA_PLAN_REF_TOKEN_RE.lastIndex).toBe(0);
  });
});
