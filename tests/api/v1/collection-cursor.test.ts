import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  decodeCollectionCursor,
  decodePageCursor,
  encodeCollectionCursor,
  encodePageCursor,
  parseCollectionPageRequest,
  readRowIdPosition,
  V1_COLLECTIONS,
} from '@/lib/api/v1/pagination';
import { ApiV1Error } from '@/lib/api/v1/errors';
import { READY_MAX_LIMIT } from '@/lib/workItems/readyFilter';

// The COLLECTION-SCOPED cursor over a service-owned position (Story 11.3 ·
// Subtask 11.3.2 — MOTIR-2059). Pure unit coverage of the codec, the collection
// scope and the parser; the endpoints that ride them are covered against real
// Postgres in their own route suites.
//
// `tests/api/v1/pagination.test.ts` covers the `(createdAt, id)` surface this
// sits BESIDE, and stays passing untouched — the "add, do not replace" property
// the card requires is asserted at the bottom of this file rather than assumed.

const BASE = 'http://localhost:3000/api/v1/things';

function req(query = ''): Request {
  return new Request(`${BASE}${query}`);
}

function expectInvalidCursor(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiV1Error);
    expect((err as ApiV1Error).code).toBe('INVALID_CURSOR');
    expect((err as ApiV1Error).status).toBe(422);
    return;
  }
  throw new Error('expected an INVALID_CURSOR error, but nothing was thrown');
}

function expectApiError(fn: () => unknown, code: string, status = 422): void {
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

/** The ready set's `(kind, priority, key)` position, read back off the wire. */
interface ReadyPosition {
  kind: string;
  priority: string;
  key: number;
}

function readReadyPosition(position: unknown): ReadyPosition | undefined {
  if (typeof position !== 'object' || position === null) return undefined;
  const { kind, priority, key } = position as Partial<ReadyPosition>;
  if (typeof kind !== 'string' || typeof priority !== 'string') return undefined;
  if (typeof key !== 'number' || !Number.isInteger(key)) return undefined;
  return { kind, priority, key };
}

/** A sprint's `sequence` position. */
function readSequencePosition(position: unknown): number | undefined {
  return typeof position === 'number' && Number.isInteger(position) ? position : undefined;
}

describe('the collection-scoped cursor carries a SERVICE-OWNED position', () => {
  // The whole point of the generalization: three collections, three genuinely
  // different position shapes, none of them `(createdAt, id)`.

  it('round-trips an opaque ROW ID — the `backlogRank`-ordered collections', () => {
    const cursor = encodeCollectionCursor('backlog', 'cms6t9sep000b04kwbhpke4xw');
    expect(decodeCollectionCursor(cursor, 'backlog', readRowIdPosition)).toBe(
      'cms6t9sep000b04kwbhpke4xw',
    );
  });

  it("round-trips the ready set's (kind, priority, key) DISPATCH tuple", () => {
    const position = { kind: 'subtask', priority: 'high', key: 2059 };
    const cursor = encodeCollectionCursor('ready', position);
    expect(decodeCollectionCursor(cursor, 'ready', readReadyPosition)).toEqual(position);
  });

  it("round-trips a sprint's `sequence`", () => {
    const cursor = encodeCollectionCursor('sprints', 7);
    expect(decodeCollectionCursor(cursor, 'sprints', readSequencePosition)).toBe(7);
  });

  it('is OPAQUE — the position does not appear in the cursor as readable text', () => {
    // Not a security claim on its own (the signature is what makes it
    // unforgeable), but the property ADR §5 asks for: a client cannot read the
    // sort key off the wire and start constructing positions.
    const cursor = encodeCollectionCursor('backlog', 'cms6t9sep000b04kwbhpke4xw');
    expect(cursor).not.toContain('cms6t9sep000b04kwbhpke4xw');
    expect(cursor).not.toContain('backlog');
  });
});

describe('a cursor is refused OUTSIDE the collection that issued it', () => {
  // The load-bearing property. Without it the two id-positioned collections
  // would decode each other's cursors cleanly and answer 200 with a page
  // positioned by a row that is not in that collection at all.

  it('refuses a backlog cursor presented to the sprint-members collection', () => {
    const cursor = encodeCollectionCursor('backlog', 'cms6t9sep000b04kwbhpke4xw');
    expectInvalidCursor(() => decodeCollectionCursor(cursor, 'sprintWorkItems', readRowIdPosition));
  });

  it('refuses it with the SAME code a tampered cursor gets', () => {
    // Deliberate: distinguishing "forged" from "wrong collection" would tell an
    // attacker which half of the check they failed, and a client can act on
    // neither — the cursor is opaque to them either way.
    const foreign = encodeCollectionCursor('ready', { kind: 'subtask', priority: 'high', key: 1 });
    let wrongCollectionCode: string | undefined;
    let tamperedCode: string | undefined;

    try {
      decodeCollectionCursor(foreign, 'backlog', readRowIdPosition);
    } catch (err) {
      wrongCollectionCode = (err as ApiV1Error).code;
    }
    try {
      decodeCollectionCursor(`${foreign}x`, 'ready', readReadyPosition);
    } catch (err) {
      tamperedCode = (err as ApiV1Error).code;
    }

    expect(wrongCollectionCode).toBe('INVALID_CURSOR');
    expect(tamperedCode).toBe('INVALID_CURSOR');
  });

  it('refuses every OTHER collection for a given cursor, not merely one', () => {
    const cursor = encodeCollectionCursor('projects', 'p-1');
    for (const collection of V1_COLLECTIONS.filter((c) => c !== 'projects')) {
      expectInvalidCursor(() => decodeCollectionCursor(cursor, collection, readRowIdPosition));
    }
    // …and still accepts its own.
    expect(decodeCollectionCursor(cursor, 'projects', readRowIdPosition)).toBe('p-1');
  });
});

describe('a bad cursor is a 422, never a silent reset to page one', () => {
  it('refuses a cursor with no signature segment', () => {
    expectInvalidCursor(() => decodeCollectionCursor('not-a-cursor', 'backlog', readRowIdPosition));
  });

  it('refuses a cursor whose payload segment is empty', () => {
    expectInvalidCursor(() => decodeCollectionCursor('.sig', 'backlog', readRowIdPosition));
  });

  it('refuses a cursor whose signature segment is empty', () => {
    expectInvalidCursor(() => decodeCollectionCursor('payload.', 'backlog', readRowIdPosition));
  });

  it('refuses a TAMPERED payload', () => {
    const cursor = encodeCollectionCursor('backlog', 'row-1');
    const [, signature] = cursor.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ c: 'backlog', p: 'row-9999' }),
      'utf8',
    ).toString('base64url');
    expectInvalidCursor(() =>
      decodeCollectionCursor(`${forgedPayload}.${signature}`, 'backlog', readRowIdPosition),
    );
  });

  it("refuses a cursor signed with ANOTHER deployment's secret", () => {
    const payload = Buffer.from(JSON.stringify({ c: 'backlog', p: 'row-1' }), 'utf8').toString(
      'base64url',
    );
    const foreignSignature = createHmac('sha256', 'some-other-deployment:api-v1-cursor')
      .update(payload)
      .digest('base64url');
    expectInvalidCursor(() =>
      decodeCollectionCursor(`${payload}.${foreignSignature}`, 'backlog', readRowIdPosition),
    );
  });

  it('refuses a validly-signed cursor whose payload is not JSON', () => {
    const payload = Buffer.from('definitely not json', 'utf8').toString('base64url');
    const signature = createHmac('sha256', `${process.env['BETTER_AUTH_SECRET']}:api-v1-cursor`)
      .update(payload)
      .digest('base64url');
    expectInvalidCursor(() =>
      decodeCollectionCursor(`${payload}.${signature}`, 'backlog', readRowIdPosition),
    );
  });

  it('refuses a validly-signed cursor whose payload is not an object', () => {
    const payload = Buffer.from(JSON.stringify('a bare string'), 'utf8').toString('base64url');
    const signature = createHmac('sha256', `${process.env['BETTER_AUTH_SECRET']}:api-v1-cursor`)
      .update(payload)
      .digest('base64url');
    expectInvalidCursor(() =>
      decodeCollectionCursor(`${payload}.${signature}`, 'backlog', readRowIdPosition),
    );
  });

  it('refuses a genuinely-signed cursor whose POSITION this collection cannot use', () => {
    // The case 11.1's own gate found, on the new surface: the signature verifies
    // and the collection matches, but the position is a shape the reader
    // rejects — an older release's payload, or a fixture built by hand.
    const cursor = encodeCollectionCursor('ready', { kind: 'subtask' });
    expectInvalidCursor(() => decodeCollectionCursor(cursor, 'ready', readReadyPosition));
  });

  it('refuses an empty-string row id rather than paging from an unnamed position', () => {
    const cursor = encodeCollectionCursor('backlog', '');
    expectInvalidCursor(() => decodeCollectionCursor(cursor, 'backlog', readRowIdPosition));
  });
});

describe('parseCollectionPageRequest', () => {
  it('defaults the limit and leaves the cursor undefined when neither is given', () => {
    const page = parseCollectionPageRequest(req(), 'backlog', readRowIdPosition);
    expect(page).toEqual({ limit: DEFAULT_PAGE_LIMIT, cursor: undefined });
  });

  it('treats an EMPTY cursor / limit as absent rather than malformed', () => {
    const page = parseCollectionPageRequest(req('?cursor=&limit='), 'backlog', readRowIdPosition);
    expect(page).toEqual({ limit: DEFAULT_PAGE_LIMIT, cursor: undefined });
  });

  it('honours a limit below the ceiling', () => {
    expect(parseCollectionPageRequest(req('?limit=25'), 'ready', readReadyPosition).limit).toBe(25);
  });

  it("clamps DOWN to v1's ceiling even where the underlying read allows more", () => {
    // The ready set's own `clampReadyLimit` permits 200. v1 documents 100 (ADR
    // §5) and clamps before the service ever sees the number — an underlying
    // read does not raise v1's cap, which is the mirror of Amendment 1's "no
    // existing cap moves".
    expect(READY_MAX_LIMIT).toBeGreaterThan(MAX_PAGE_LIMIT);
    const page = parseCollectionPageRequest(
      req(`?limit=${READY_MAX_LIMIT}`),
      'ready',
      readReadyPosition,
    );
    expect(page.limit).toBe(MAX_PAGE_LIMIT);
  });

  it.each([
    ['0', 'zero'],
    ['-1', 'a negative'],
    ['1.5', 'a fractional'],
    ['abc', 'a non-numeric'],
  ])('rejects limit=%s (%s) with 422 rather than coercing it', (raw) => {
    expectApiError(
      () => parseCollectionPageRequest(req(`?limit=${raw}`), 'backlog', readRowIdPosition),
      'INVALID_LIMIT',
    );
  });

  it('decodes a cursor issued for the SAME collection', () => {
    const cursor = encodeCollectionCursor('backlog', 'row-42');
    const page = parseCollectionPageRequest(
      req(`?cursor=${encodeURIComponent(cursor)}`),
      'backlog',
      readRowIdPosition,
    );
    expect(page.cursor).toBe('row-42');
  });

  it('refuses a cursor issued for a DIFFERENT collection', () => {
    const cursor = encodeCollectionCursor('sprintWorkItems', 'row-42');
    expectInvalidCursor(() =>
      parseCollectionPageRequest(
        req(`?cursor=${encodeURIComponent(cursor)}`),
        'backlog',
        readRowIdPosition,
      ),
    );
  });

  it('validates the LIMIT before the cursor, so a caller sees the fixable error first', () => {
    // Both are wrong; the limit is the one a caller can see and correct without
    // guessing at an opaque token.
    expectApiError(
      () =>
        parseCollectionPageRequest(req('?limit=0&cursor=garbage'), 'backlog', readRowIdPosition),
      'INVALID_LIMIT',
    );
  });
});

describe('the shipped (createdAt, id) surface is UNCHANGED', () => {
  // "Add, do not replace": 11.2's six endpoints and `GET /api/v1/workspaces`
  // ride the original codec and must not have moved under them.

  it('still round-trips a `(createdAt, id)` cursor', () => {
    const position = { createdAt: '2026-08-04T10:00:00.000Z', id: 'row-1' };
    expect(decodePageCursor(encodePageCursor(position))).toEqual(position);
  });

  it('does not accept a collection cursor at the original decoder', () => {
    // The two codecs share a signing key, so this is a real risk rather than a
    // theoretical one: the signature VERIFIES and only the payload shape refuses
    // it. Without that shape check a backlog cursor would decode here into a
    // `(createdAt, id)` position with both fields undefined.
    const collectionCursor = encodeCollectionCursor('backlog', 'row-1');
    expectInvalidCursor(() => decodePageCursor(collectionCursor));
  });

  it('does not accept an original cursor at the collection decoder', () => {
    const pageCursor = encodePageCursor({ createdAt: '2026-08-04T10:00:00.000Z', id: 'row-1' });
    expectInvalidCursor(() => decodeCollectionCursor(pageCursor, 'backlog', readRowIdPosition));
  });
});
