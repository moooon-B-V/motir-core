import { describe, expect, it } from 'vitest';
import {
  decodeHomeCursor,
  decodeWatchingCursor,
  encodeHomeCursor,
  encodeWatchingCursor,
} from '@/lib/workbench/cursor';

// The cursor's INVARIANTS (Story MOTIR-4777 · MOTIR-4784).
//
// `personal-reads.test.ts` covers the round trip and the two degradations a
// read depends on. This file covers the one thing a fixture cannot reach and a
// coverage report therefore reports as a gap: the `catch` inside `splitToken`.
//
// ⚠️ IT IS UNREACHABLE, AND THAT IS THE POINT. `Buffer.from(x, 'base64url')`
// DISCARDS characters outside the alphabet rather than throwing, so there is no
// string that enters that branch — the arm is a fact about Node's decoder, not
// about this module, and the right answer to an unreachable arm is the
// INVARIANT plus an ignore directive naming this test, never a fixture nobody
// can build (`motir-core/CLAUDE.md`; the card's own instruction). A fixture
// proves one path; an invariant proves the class, which is strictly the
// stronger of the two.
//
// What the invariant is FOR: this token arrives from a URL, so every value here
// is one a person can type into the address bar of a LANDING page. Whatever
// arrives, the answer is page one — never a 500 on the first screen after
// signing in.

/** Every shape a hand-edited, truncated or hostile `?cursor=` can take. */
const MALFORMED = [
  '',
  ' ',
  '!!!!',
  '====',
  '@@@@@@@@',
  '\u00a0\t\n',
  '\ud83d\udca5',
  'a'.repeat(10_000),
  '../../etc/passwd',
  '%2e%2e%2f',
  Buffer.from('', 'utf8').toString('base64url'),
  Buffer.from('|', 'utf8').toString('base64url'),
  Buffer.from('|abc', 'utf8').toString('base64url'),
  Buffer.from('2026-06-15T12:00:00.000Z|', 'utf8').toString('base64url'),
  Buffer.from('not-a-date|abc', 'utf8').toString('base64url'),
  Buffer.from('2026-13-45T99:99:99.000Z|abc', 'utf8').toString('base64url'),
  Buffer.from('2026-06-15T12:00:00.000Z', 'utf8').toString('base64url'),
];

describe('the cursor never throws, whatever arrives in the URL', () => {
  it('degrades every malformed token to page one, on BOTH decoders', () => {
    for (const token of MALFORMED) {
      expect(() => decodeHomeCursor(token), `home threw on ${JSON.stringify(token)}`).not.toThrow();
      expect(
        () => decodeWatchingCursor(token),
        `watching threw on ${JSON.stringify(token)}`,
      ).not.toThrow();
      expect(decodeHomeCursor(token), `home decoded ${JSON.stringify(token)}`).toBeNull();
      expect(decodeWatchingCursor(token), `watching decoded ${JSON.stringify(token)}`).toBeNull();
    }
  });

  it('and on the absent forms, which is how page one asks for itself', () => {
    for (const token of [null, undefined]) {
      expect(decodeHomeCursor(token)).toBeNull();
      expect(decodeWatchingCursor(token)).toBeNull();
    }
  });

  it('SENSITIVITY — the corpus is not vacuous: a well-formed token still decodes', () => {
    // Without this, every assertion above would pass on a decoder that returned
    // `null` unconditionally — which is a page-one loop, not a degradation.
    const at = new Date('2026-06-15T12:00:00.000Z');
    expect(decodeHomeCursor(encodeHomeCursor({ at, id: 'wi_1' }))).toEqual({ at, id: 'wi_1' });
    expect(decodeWatchingCursor(encodeWatchingCursor({ at, id: 'wi_1', group: 'todo' }))).toEqual({
      at,
      id: 'wi_1',
      group: 'todo',
    });
  });

  it('the base64url DECODER does not throw — the fact the ignored arm rests on', () => {
    // Stated as an assertion rather than as a comment, because it is the reason
    // `splitToken`'s catch is marked unreachable. If a Node upgrade ever makes
    // this throw, THIS is the test that says so, and the ignore directive above
    // that arm cites it by name.
    for (const token of MALFORMED) {
      expect(() => Buffer.from(token, 'base64url').toString('utf8')).not.toThrow();
    }
  });
});
