import { describe, expect, it } from 'vitest';
import {
  decodeChangelogCursor,
  encodeChangelogCursor,
  InvalidChangelogCursorError,
} from '@/lib/publicProjects/changelogCursor';

// Story 8.9 · Subtask 8.9.3 — the changelog's opaque page cursor.
//
// The validation half is the point. A cursor that decodes to `NaN` or to an
// `Invalid Date` does not throw when it reaches SQL: every comparison against it
// is FALSE, so the read returns an EMPTY page and the pager silently stops.
// That failure is indistinguishable from "you have reached the end", which is
// why each field is checked here rather than trusted downstream.

describe('encodeChangelogCursor / decodeChangelogCursor', () => {
  it('round-trips a position', () => {
    const token = { shippedAt: '2026-08-01T10:00:00.000Z', key: 42 };
    expect(decodeChangelogCursor(encodeChangelogCursor(token))).toEqual(token);
  });

  it('produces a URL-safe token', () => {
    const raw = encodeChangelogCursor({ shippedAt: '2026-08-01T10:00:00.000Z', key: 1 });
    // base64url — no `+`, `/` or `=`, so it survives a query string untouched.
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 at all', '!!!not-base64!!!'],
    ['valid base64 that is not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['a JSON object rather than the tuple', Buffer.from('{"a":1}', 'utf8').toString('base64url')],
    [
      'a tuple of the wrong length',
      Buffer.from('["2026-01-01",1,2]', 'utf8').toString('base64url'),
    ],
    ['an empty timestamp', Buffer.from('["",1]', 'utf8').toString('base64url')],
    [
      'a timestamp that is not a date',
      Buffer.from('["yesterday",1]', 'utf8').toString('base64url'),
    ],
    [
      'a non-integer key',
      Buffer.from('["2026-01-01T00:00:00Z",1.5]', 'utf8').toString('base64url'),
    ],
    ['a zero key', Buffer.from('["2026-01-01T00:00:00Z",0]', 'utf8').toString('base64url')],
    ['a string key', Buffer.from('["2026-01-01T00:00:00Z","1"]', 'utf8').toString('base64url')],
  ])('throws on %s', (_label, raw) => {
    expect(() => decodeChangelogCursor(raw)).toThrow(InvalidChangelogCursorError);
  });
});
