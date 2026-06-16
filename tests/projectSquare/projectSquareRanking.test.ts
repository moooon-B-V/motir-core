import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectSquareService } from '@/lib/services/projectSquareService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import {
  InvalidProjectSquareCursorError,
  InvalidProjectSquareRankError,
  InvalidProjectSquareWindowError,
} from '@/lib/projectSquare/errors';
import { decodeRankedCursor, encodeRankedCursor } from '@/lib/projectSquare/rankCursor';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';

// Story 6.13 · Subtask 6.13.4 — the PROJECT SQUARE ranking: trending (recent
// windowed upvotes + activity), popular (lifetime upvotes), recent (made-public
// timestamp). Each a DETERMINISTIC total order over the 6.12.6 signals, riding
// the 6.13.2 keyset cursor. Real Postgres (no DB mocks); the truncate helper
// CASCADE-resets organization → workspace → project → work_item →
// public_request_vote between tests.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Make `fx`'s project `public` directly (no go-public stamp), optionally pinning timestamps. */
async function makePublic(
  projectId: string,
  pins: { madePublicAt?: Date | null; createdAt?: Date } = {},
): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: {
      accessLevel: 'public',
      ...(pins.madePublicAt !== undefined ? { madePublicAt: pins.madePublicAt } : {}),
      ...(pins.createdAt !== undefined ? { createdAt: pins.createdAt } : {}),
    },
  });
}

/** Add `count` upvotes (each a distinct voter) on a fresh request, stamped at `at`. */
async function addVotesAt(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  count: number,
  at: Date,
): Promise<void> {
  const request = await createTestWorkItem(fx, { kind: 'task', title: 'a public request' });
  for (let i = 0; i < count; i++) {
    const voter = await createTestUser();
    await db.publicRequestVote.create({
      data: { workItemId: request.id, userId: voter.id, createdAt: at },
    });
  }
}

const NOW = Date.now();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

describe('projectSquareService.listDirectory — popular rank (lifetime upvotes)', () => {
  it('orders by total upvotes desc, deterministically', async () => {
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    await makePublic(a.projectId);
    await addVotesAt(a, 1, days(0));
    const b = await makeWorkItemFixture({ name: 'B', identifier: 'BBB' });
    await makePublic(b.projectId);
    await addVotesAt(b, 5, days(0));
    const c = await makeWorkItemFixture({ name: 'C', identifier: 'CCC' });
    await makePublic(c.projectId);
    await addVotesAt(c, 3, days(0));

    const page = await projectSquareService.listDirectory({ rank: 'popular' });
    expect(page.items.map((i) => i.identifier)).toEqual(['BBB', 'CCC', 'AAA']);
    // The displayed lifetime stat matches the rank key for popular.
    expect(page.items.map((i) => i.stats.upvotes)).toEqual([5, 3, 1]);
  });
});

describe('projectSquareService.listDirectory — trending rank (recent windowed demand)', () => {
  it('floats a fresh upvote burst above a higher-lifetime-but-stale project', async () => {
    // FRESH: 2 upvotes inside the default week window.
    const fresh = await makeWorkItemFixture({ name: 'Fresh', identifier: 'FRS' });
    await makePublic(fresh.projectId);
    await addVotesAt(fresh, 2, days(0));
    // STALE: 5 upvotes, all 60 days ago (outside the week window).
    const stale = await makeWorkItemFixture({ name: 'Stale', identifier: 'STL' });
    await makePublic(stale.projectId);
    await addVotesAt(stale, 5, days(60));

    // Trending: FRESH (recent demand) outranks STALE.
    const trending = await projectSquareService.listDirectory({ rank: 'trending' });
    expect(trending.items.map((i) => i.identifier)).toEqual(['FRS', 'STL']);

    // Popular (lifetime): the order INVERTS — STALE has more total upvotes.
    const popular = await projectSquareService.listDirectory({ rank: 'popular' });
    expect(popular.items.map((i) => i.identifier)).toEqual(['STL', 'FRS']);
  });

  it('a wider window pulls a stale burst back into the trending signal', async () => {
    const fresh = await makeWorkItemFixture({ name: 'Fresh', identifier: 'FRS' });
    await makePublic(fresh.projectId);
    await addVotesAt(fresh, 1, days(0));
    const lastMonth = await makeWorkItemFixture({ name: 'LastMonth', identifier: 'LMO' });
    await makePublic(lastMonth.projectId);
    await addVotesAt(lastMonth, 4, days(20)); // inside `month`, outside `week`

    // week: the 20-day-old burst is out of window → FRESH leads.
    const week = await projectSquareService.listDirectory({ rank: 'trending', window: 'week' });
    expect(week.items.map((i) => i.identifier)).toEqual(['FRS', 'LMO']);
    // month: the 20-day-old burst counts → LastMonth (4 votes) overtakes FRESH.
    const month = await projectSquareService.listDirectory({ rank: 'trending', window: 'month' });
    expect(month.items.map((i) => i.identifier)).toEqual(['LMO', 'FRS']);
  });
});

describe('projectSquareService.listDirectory — recent rank (made-public timestamp)', () => {
  it('orders by madePublicAt desc, falling back to createdAt when unset', async () => {
    // A made public most recently (Mar); C made public oldest (Jan); B has no
    // made-public stamp but a Feb createdAt → COALESCE puts it between A and C.
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    await makePublic(a.projectId, { madePublicAt: new Date('2026-03-03T00:00:00.000Z') });
    const b = await makeWorkItemFixture({ name: 'B', identifier: 'BBB' });
    await makePublic(b.projectId, {
      madePublicAt: null,
      createdAt: new Date('2026-02-02T00:00:00.000Z'),
    });
    const c = await makeWorkItemFixture({ name: 'C', identifier: 'CCC' });
    await makePublic(c.projectId, { madePublicAt: new Date('2026-01-01T00:00:00.000Z') });

    const page = await projectSquareService.listDirectory({ rank: 'recent' });
    expect(page.items.map((i) => i.identifier)).toEqual(['AAA', 'BBB', 'CCC']);
  });
});

describe('projectRepository.listPublicDirectoryRanked — keyset determinism', () => {
  it('walks every project once on a tied-score rank (id tiebreak branch)', async () => {
    // Five public projects; three with zero votes (tied score 0) so the keyset
    // `id` tiebreak is exercised, two with distinct vote totals.
    for (let i = 0; i < 3; i++) {
      const fx = await makeWorkItemFixture({ name: `Z${i}`, identifier: `Z0${i}` });
      await makePublic(fx.projectId);
    }
    const v1 = await makeWorkItemFixture({ name: 'V1', identifier: 'V01' });
    await makePublic(v1.projectId);
    await addVotesAt(v1, 2, days(0));
    const v2 = await makeWorkItemFixture({ name: 'V2', identifier: 'V02' });
    await makePublic(v2.projectId);
    await addVotesAt(v2, 1, days(0));

    const seen = new Set<string>();
    let cursor: { score: number; id: string } | undefined;
    for (;;) {
      const rows = await projectRepository.listPublicDirectoryRanked({
        rank: 'popular',
        take: 1,
        cursor,
      });
      if (rows.length === 0) break;
      const row = rows[0]!;
      expect(seen.has(row.id)).toBe(false); // never a duplicate across pages
      seen.add(row.id);
      cursor = { score: row.sortScore!, id: row.id };
      if (seen.size > 5) break; // guard against a non-terminating cursor
    }
    expect(seen.size).toBe(5); // every public project surfaced exactly once
  });
});

describe('projectMembersService.setAccessLevel — madePublicAt stamp', () => {
  it('stamps madePublicAt on the transition INTO public and keeps it on re-save', async () => {
    const fx = await makeWorkItemFixture({ name: 'Pub', identifier: 'PUB' });
    expect((await db.project.findUnique({ where: { id: fx.projectId } }))!.madePublicAt).toBeNull();

    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'public',
    });
    const first = (await db.project.findUnique({ where: { id: fx.projectId } }))!.madePublicAt;
    expect(first).not.toBeNull();

    // Re-saving an already-public project keeps the original go-public moment.
    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'public',
    });
    const second = (await db.project.findUnique({ where: { id: fx.projectId } }))!.madePublicAt;
    expect(second!.getTime()).toBe(first!.getTime());

    // The freshly-public project shows up in the Recent rank.
    const page = await projectSquareService.listDirectory({ rank: 'recent' });
    expect(page.items.some((i) => i.identifier === 'PUB')).toBe(true);
  });
});

describe('projectSquareService.listDirectory — input validation', () => {
  it('rejects an unrecognised rank with InvalidProjectSquareRankError', async () => {
    await expect(projectSquareService.listDirectory({ rank: 'bogus' })).rejects.toBeInstanceOf(
      InvalidProjectSquareRankError,
    );
  });

  it('rejects an unrecognised trending window with InvalidProjectSquareWindowError', async () => {
    await expect(
      projectSquareService.listDirectory({ rank: 'trending', window: 'year' }),
    ).rejects.toBeInstanceOf(InvalidProjectSquareWindowError);
  });

  it('rejects a cursor minted under a DIFFERENT rank (a tab switch must restart)', async () => {
    const crossRank = encodeRankedCursor({
      rank: 'popular',
      window: null,
      score: 3,
      ts: null,
      id: 'abc123',
    });
    await expect(
      projectSquareService.listDirectory({ rank: 'recent', cursor: crossRank }),
    ).rejects.toBeInstanceOf(InvalidProjectSquareCursorError);
  });
});

describe('ranked cursor codec', () => {
  it('round-trips a numeric (popular) keyset position', () => {
    const c = decodeRankedCursor(
      encodeRankedCursor({ rank: 'popular', window: null, score: 7, ts: null, id: 'abc' }),
    );
    expect(c).toEqual({ rank: 'popular', window: null, score: 7, ts: null, id: 'abc' });
  });

  it('round-trips a timestamp (recent) keyset position', () => {
    const iso = '2026-06-14T12:00:00.000Z';
    const c = decodeRankedCursor(
      encodeRankedCursor({ rank: 'recent', window: null, score: null, ts: iso, id: 'xyz' }),
    );
    expect(c).toEqual({ rank: 'recent', window: null, score: null, ts: iso, id: 'xyz' });
  });

  it('round-trips a trending position carrying its window', () => {
    const c = decodeRankedCursor(
      encodeRankedCursor({ rank: 'trending', window: 'day', score: 12, ts: null, id: 'q1' }),
    );
    expect(c).toEqual({ rank: 'trending', window: 'day', score: 12, ts: null, id: 'q1' });
  });

  it('throws InvalidProjectSquareCursorError on malformed / mis-shaped tokens', () => {
    expect(() => decodeRankedCursor('not-a-valid-cursor')).toThrow(InvalidProjectSquareCursorError);
    // A well-formed base64url JSON but an unknown rank.
    const badRank = Buffer.from(JSON.stringify({ r: 'nope', i: 'x', s: 1 }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeRankedCursor(badRank)).toThrow(InvalidProjectSquareCursorError);
    // A recent cursor missing its ts.
    const noTs = Buffer.from(
      JSON.stringify({ r: 'recent', i: 'x', s: null, t: null }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeRankedCursor(noTs)).toThrow(InvalidProjectSquareCursorError);
    // A trending cursor missing its window.
    const noWin = Buffer.from(
      JSON.stringify({ r: 'trending', i: 'x', s: 1, w: null }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeRankedCursor(noWin)).toThrow(InvalidProjectSquareCursorError);
  });
});
