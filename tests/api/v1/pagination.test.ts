import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  decodePageCursor,
  encodePageCursor,
  paginateKeyset,
  parsePageRequest,
} from '@/lib/api/v1/pagination';
import { ApiV1Error } from '@/lib/api/v1/errors';

// The v1 pagination primitive (Story 11.1 · Subtask 11.1.3 — MOTIR-1859).
// Pure unit coverage of the cursor + the parser + the keyset slice; the
// endpoint that rides them is covered against real Postgres in
// `workspaces-route.test.ts`.

const BASE = 'http://localhost:3000/api/v1/things';

function req(query = '') {
  return new Request(`${BASE}${query}`);
}

/** A row shaped like anything keyset-pageable. */
function row(id: string, isoTime: string) {
  return { id, createdAt: new Date(isoTime) };
}

function expectApiError(fn: () => unknown, code: string, status = 422) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiV1Error);
    expect((err as ApiV1Error).code).toBe(code);
    expect((err as ApiV1Error).status).toBe(status);
    return;
  }
  throw new Error(`expected a ${code} error, but nothing was thrown`);
}

describe('parsePageRequest — limit', () => {
  it('defaults to 50 when absent or empty', () => {
    expect(parsePageRequest(req()).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsePageRequest(req('?limit=')).limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it('CLAMPS above the ceiling rather than rejecting', () => {
    expect(parsePageRequest(req('?limit=101')).limit).toBe(MAX_PAGE_LIMIT);
    expect(parsePageRequest(req('?limit=100000')).limit).toBe(MAX_PAGE_LIMIT);
    expect(parsePageRequest(req('?limit=100')).limit).toBe(100);
    expect(parsePageRequest(req('?limit=1')).limit).toBe(1);
  });

  // Rejected, never coerced: silently turning `limit=0` into 50 hands the
  // caller a page they did not ask for and hides their bug.
  it.each([
    ['zero', '?limit=0'],
    ['negative', '?limit=-5'],
    ['non-numeric', '?limit=lots'],
    ['fractional', '?limit=2.5'],
    ['whitespace', '?limit=%20'],
  ])('rejects a %s limit with 422 INVALID_LIMIT', (_label, query) => {
    expectApiError(() => parsePageRequest(req(query)), 'INVALID_LIMIT');
  });
});

describe('parsePageRequest — cursor', () => {
  it('round-trips a cursor it issued', () => {
    const raw = encodePageCursor({ createdAt: '2026-08-03T10:00:00.000Z', id: 'row-7' });

    expect(parsePageRequest(req(`?cursor=${encodeURIComponent(raw)}`)).cursor).toEqual({
      createdAt: '2026-08-03T10:00:00.000Z',
      id: 'row-7',
    });
  });

  it('is undefined when absent or empty', () => {
    expect(parsePageRequest(req()).cursor).toBeUndefined();
    expect(parsePageRequest(req('?cursor=')).cursor).toBeUndefined();
  });

  // Never a silent reset to page one — that is the failure mode that makes a
  // client loop forever over the first page.
  it.each([
    ['garbage', 'not-a-cursor'],
    [
      'unsigned',
      Buffer.from('{"id":"x","createdAt":"2026-01-01T00:00:00Z"}').toString('base64url'),
    ],
    ['empty signature', `${Buffer.from('{}').toString('base64url')}.`],
    ['signature only', '.abcdef'],
  ])('rejects a %s cursor with 422 INVALID_CURSOR', (_label, raw) => {
    expectApiError(() => decodePageCursor(raw), 'INVALID_CURSOR');
  });

  it('rejects a TAMPERED cursor — the payload cannot be edited in flight', () => {
    const raw = encodePageCursor({ createdAt: '2026-08-03T10:00:00.000Z', id: 'row-7' });
    const [payload, signature] = raw.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ createdAt: '2026-08-03T10:00:00.000Z', id: 'row-999' }),
      'utf8',
    ).toString('base64url');

    expectApiError(() => decodePageCursor(`${forgedPayload}.${signature}`), 'INVALID_CURSOR');
    expect(payload).not.toBe(forgedPayload);
  });

  // The opacity property: a client that knows the row's sort key STILL cannot
  // build a working cursor, so the keyset never becomes public API and a future
  // index change is not a breaking change.
  it('cannot be CONSTRUCTED from row data — opacity is enforced, not hoped for', () => {
    const known = { createdAt: '2026-08-03T10:00:00.000Z', id: 'row-7' };

    // Every shape a client could plausibly guess from the row it just read.
    const guesses = [
      JSON.stringify(known),
      Buffer.from(JSON.stringify(known), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify(known), 'utf8').toString('base64'),
      `${known.createdAt}|${known.id}`,
      known.id,
      `${Buffer.from(JSON.stringify(known), 'utf8').toString('base64url')}.deadbeef`,
    ];

    for (const guess of guesses) {
      expectApiError(() => decodePageCursor(guess), 'INVALID_CURSOR');
    }
  });

  // The signature check is not the only gate. A VALIDLY-SIGNED payload whose
  // shape is wrong must still be refused — otherwise a bad deploy, or a
  // cursor format change, would flow garbage into the keyset comparison. The
  // test signs with the server secret itself (the only way to get past the
  // HMAC on purpose) so these branches are genuinely exercised.
  it('rejects a VALIDLY-SIGNED cursor whose payload is not a keyset position', () => {
    const signedByServer = (value: unknown) => {
      const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
      const signature = createHmac('sha256', `${process.env['BETTER_AUTH_SECRET']}:api-v1-cursor`)
        .update(payload)
        .digest('base64url');
      return `${payload}.${signature}`;
    };

    // Sanity: the helper really does produce cursors that PASS the signature
    // gate, so the rejections below are the shape check talking.
    expect(
      decodePageCursor(signedByServer({ createdAt: '2026-01-01T00:00:00.000Z', id: 'x' })),
    ).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', id: 'x' });

    expectApiError(() => decodePageCursor(signedByServer({ id: 'x' })), 'INVALID_CURSOR');
    expectApiError(() => decodePageCursor(signedByServer(null)), 'INVALID_CURSOR');
    expectApiError(() => decodePageCursor(signedByServer('a string')), 'INVALID_CURSOR');
    expectApiError(
      () => decodePageCursor(signedByServer({ id: 7, createdAt: '2026-01-01T00:00:00.000Z' })),
      'INVALID_CURSOR',
    );
    expectApiError(
      () => decodePageCursor(signedByServer({ id: 'x', createdAt: 'not-a-date' })),
      'INVALID_CURSOR',
    );
    expectApiError(() => decodePageCursor(signedByServer('not json at all')), 'INVALID_CURSOR');
  });
});

describe('paginateKeyset', () => {
  const rows = [
    row('a', '2026-08-01T00:00:00.000Z'),
    row('b', '2026-08-02T00:00:00.000Z'),
    row('c', '2026-08-03T00:00:00.000Z'),
    row('d', '2026-08-04T00:00:00.000Z'),
    row('e', '2026-08-05T00:00:00.000Z'),
  ];
  const id = (r: { id: string }) => r.id;

  it('walks the whole collection exactly once, then reports no next cursor', () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: { items: string[]; nextCursor: string | null } = paginateKeyset(
        rows,
        { limit: 2, cursor: cursor ? decode(cursor) : undefined },
        id,
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(cursor).toBeNull();
    // 2 + 2 + 1 — the last page reports null rather than costing an extra
    // empty round trip.
    expect(pages).toBe(3);
  });

  it('returns a 200-shaped empty envelope for an empty collection', () => {
    expect(paginateKeyset([], { limit: 10, cursor: undefined }, id)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('breaks timestamp ties by id, so the order is TOTAL', () => {
    const tied = [
      row('z', '2026-08-01T00:00:00.000Z'),
      row('a', '2026-08-01T00:00:00.000Z'),
      row('m', '2026-08-01T00:00:00.000Z'),
    ];

    const first = paginateKeyset(tied, { limit: 2, cursor: undefined }, id);
    const second = paginateKeyset(
      tied,
      { limit: 2, cursor: decode(first.nextCursor as string) },
      id,
    );

    expect(first.items).toEqual(['a', 'm']);
    expect(second.items).toEqual(['z']);
  });

  it('treats a cursor past the tail as an exhausted position, not an error', () => {
    const past = encodePageCursor({ createdAt: '2099-01-01T00:00:00.000Z', id: 'zzz' });

    expect(paginateKeyset(rows, { limit: 10, cursor: decode(past) }, id)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  // The property offset pagination CANNOT provide, asserted directly on the
  // primitive; `workspaces-route.test.ts` asserts the same end to end.
  it('skips nothing and duplicates nothing when rows are inserted MID-SCAN', () => {
    const live = [...rows];
    const seen: string[] = [];

    const page1 = paginateKeyset(live, { limit: 2, cursor: undefined }, id);
    seen.push(...page1.items); // a, b — the cursor now sits at b (08-02)

    // Two inserts land between fetches, one on each side of the cursor.
    // Under an OFFSET pager the first one shifts every later row right by
    // one, which re-serves 'b' and never serves 'e'. Under a keyset cursor
    // neither can disturb the walk.
    live.push(row('before-cursor', '2026-08-01T12:00:00.000Z'));
    live.push(row('after-cursor', '2026-08-02T12:00:00.000Z'));

    let cursor = page1.nextCursor;
    while (cursor) {
      const page: { items: string[]; nextCursor: string | null } = paginateKeyset(
        live,
        { limit: 2, cursor: decode(cursor) },
        id,
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
    }

    // Every ORIGINAL row exactly once, in order, with no duplicate anywhere.
    expect(seen.filter((s) => rows.some((r) => r.id === s))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(seen).size).toBe(seen.length);
    // A row inserted BEFORE the cursor belongs to a page already handed out,
    // so it is correctly not re-shown — showing it is what would duplicate.
    expect(seen).not.toContain('before-cursor');
    // A row inserted AFTER the cursor simply arrives on a later page.
    expect(seen).toContain('after-cursor');
  });

  it('serves a row appended past the tail on the final page', () => {
    const live = [...rows];
    const page1 = paginateKeyset(live, { limit: 2, cursor: undefined }, id);
    live.push(row('f', '2026-08-09T00:00:00.000Z'));

    const seen: string[] = [...page1.items];
    let cursor = page1.nextCursor;
    while (cursor) {
      const page: { items: string[]; nextCursor: string | null } = paginateKeyset(
        live,
        { limit: 2, cursor: decode(cursor) },
        id,
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('is reusable — a SECOND collection shape adopts it with no parsing logic of its own', () => {
    const others = [
      { id: 'p1', createdAt: new Date('2026-08-01T00:00:00.000Z'), title: 'One' },
      { id: 'p2', createdAt: new Date('2026-08-02T00:00:00.000Z'), title: 'Two' },
    ];

    expect(
      paginateKeyset(others, { limit: 1, cursor: undefined }, (r) => ({ title: r.title })),
    ).toMatchObject({ items: [{ title: 'One' }] });
  });
});

/** Decode a cursor the way `parsePageRequest` does, for multi-page walks. */
function decode(raw: string) {
  return decodePageCursor(raw);
}
