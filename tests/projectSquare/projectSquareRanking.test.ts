import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { scannedTestCount, testsRidingTheDefaultTimeout } from '../helpers/timeoutBudget';

// Story 6.13 · Subtask 6.13.4 — the PROJECT SQUARE ranking: trending (recent
// windowed upvotes + activity), popular (lifetime upvotes), recent (made-public
// timestamp). Each a DETERMINISTIC total order over the 6.12.6 signals, riding
// the 6.13.2 keyset cursor. Real Postgres (no DB mocks); the truncate helper
// CASCADE-resets organization → workspace → project → work_item →
// public_request_vote between tests.

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-3167 — WHY THIS GROUP DOES **NOT** GET ITS OWN LANE.
//
// The card asked the question because MOTIR-3144 had just answered it the other
// way for the whole-tree structural guards, and the two situations look alike
// from a distance. They are opposites. Those guards are NOT database tests: they
// parse `lib/` + `app/` through the TypeScript compiler API, touch no Postgres,
// and were paying CPU contention inside a sharded DB job for nothing — moving
// them REMOVED a cost. `tests/projectSquare/**` is real-Postgres integration
// work, which is precisely what the sharded suite exists to run; a lane of its
// own would have to provision the service container and the per-worker clones
// again, i.e. rebuild the thing it left, and pay that fixed setup to run ~24 s
// of tests (measured: the whole six-file group, 76 tests).
//
// And a lane would not fix this defect anyway. The failure is a FIXED timer
// around a LOAD-DEPENDENT cost; a lane on a busy runner has the same excursion,
// so it would move the bomb rather than defuse it. Only an explicit budget
// removes the failure mode — which is the card's own conclusion, and
// `notes.html` #38 one altitude up: you scale a shared-fixture suite by adding
// CI jobs that each own a database, not by carving files out of the ones that
// do. These six files are already spread across the three existing shards, which
// IS that mechanism working.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The budget for every test here that touches real Postgres (MOTIR-3167).
 *
 * ⚠️ NOT DECORATION, AND NOT SIZED OFF THE LOCAL NUMBER. These tests used to
 * ride `vitest.config.ts`'s global 15 s `testTimeout` — a default nobody chose
 * for them, ample the day the file was written. On 2026-08-19 the keyset walk
 * below crossed it on a CI runner and failed motir-core#2175 as a bare
 * `Test timed out in 15000ms` with no assertion text, on a diff that touches no
 * file this one imports.
 *
 * The measurements the 60 s is sized off, all of them per FILE unless stated:
 *
 * | where                                | ranking file | worst single test |
 * |--------------------------------------|--------------|-------------------|
 * | CI, green `main` (run 32303064577)   | 13 979 ms    | not reported      |
 * | CI, red #2175 (run 32306131276)      | 32 266 ms    | > 15 000 ms (lost)|
 * | local, contended box                 |  6 897 ms    |  1 359 ms         |
 * | local, quiet box                     |  3 461 ms    |    804 ms         |
 *
 * Two things follow, and only the second sets the number. First, the local
 * figure is worthless on its own: two runs on the same box an hour apart differ
 * by 2×, and CI is another 4× above the quieter of them. Second, the test that
 * actually lost was ~3.3 s of CI time at its green-run share and still went past
 * 15 s under load — an excursion of at least 4.6×, which is the load-dependence
 * a fixed timer cannot see.
 *
 * 60 s is therefore ~4× the whole file's green CI cost and ~18× the worst test's
 * — chosen the way `packages/cli/test/releaseCli.test.ts` chose 30 s for its
 * subprocesses (MOTIR-2017), because the number is NOT measuring the work. It is
 * the point at which we would rather hear "this hung" than keep waiting. It also
 * matches `vitest.guards.config.ts`, which raised the same 15 s default to 60 s
 * for the same reason one card earlier (MOTIR-3144).
 */
const DB_TEST_TIMEOUT_MS = 60_000;

/**
 * The budget for the tests that touch NO database — the synchronous cursor-codec
 * round trips, and the source guard at the foot of the file.
 *
 * They measure 134–174 ms locally, essentially all of it module import rather
 * than work, so 5 s is ~30× headroom and still a real bound. They get an
 * explicit one for the same reason the DB tests do: the guard below is a SCAN
 * over every `it(` in the file, and a scan with a "unless it looks cheap" arm is
 * a scan somebody has to keep true. Every test declares its budget; none of them
 * inherits a global.
 */
const PURE_TEST_TIMEOUT_MS = 5_000;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Make `fx`'s project `public` directly (no go-public stamp), optionally pinning timestamps. */
async function makePublic(
  projectId: string,
  pins: { madePublicAt?: Date | null; createdAt?: Date } = {},
): Promise<void> {
  await adminDb.project.update({
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
    await adminDb.publicRequestVote.create({
      data: { workItemId: request.id, userId: voter.id, createdAt: at },
    });
  }
}

const NOW = Date.now();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

describe('projectSquareService.listDirectory — popular rank (lifetime upvotes)', () => {
  it(
    'orders by total upvotes desc, deterministically',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
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
    },
  );
});

describe('projectSquareService.listDirectory — trending rank (recent windowed demand)', () => {
  it(
    'floats a fresh upvote burst above a higher-lifetime-but-stale project',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
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
    },
  );

  it(
    'a wider window pulls a stale burst back into the trending signal',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
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
    },
  );
});

describe('projectSquareService.listDirectory — recent rank (made-public timestamp)', () => {
  it(
    'orders by madePublicAt desc, falling back to createdAt when unset',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
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
    },
  );
});

describe('projectRepository.listPublicDirectoryRanked — keyset determinism', () => {
  it(
    'walks every project once on a tied-score rank (id tiebreak branch)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
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
    },
  );
});

describe('projectMembersService.setAccessLevel — madePublicAt stamp', () => {
  it(
    'stamps madePublicAt on the transition INTO public and keeps it on re-save',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const fx = await makeWorkItemFixture({ name: 'Pub', identifier: 'PUB' });
      expect(
        (await adminDb.project.findUnique({ where: { id: fx.projectId } }))!.madePublicAt,
      ).toBeNull();

      await projectMembersService.setAccessLevel({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        level: 'public',
      });
      const first = (await adminDb.project.findUnique({ where: { id: fx.projectId } }))!
        .madePublicAt;
      expect(first).not.toBeNull();

      // Re-saving an already-public project keeps the original go-public moment.
      await projectMembersService.setAccessLevel({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        level: 'public',
      });
      const second = (await adminDb.project.findUnique({ where: { id: fx.projectId } }))!
        .madePublicAt;
      expect(second!.getTime()).toBe(first!.getTime());

      // The freshly-public project shows up in the Recent rank.
      const page = await projectSquareService.listDirectory({ rank: 'recent' });
      expect(page.items.some((i) => i.identifier === 'PUB')).toBe(true);
    },
  );
});

describe('projectSquareService.listDirectory — input validation', () => {
  it(
    'rejects an unrecognised rank with InvalidProjectSquareRankError',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      await expect(projectSquareService.listDirectory({ rank: 'bogus' })).rejects.toBeInstanceOf(
        InvalidProjectSquareRankError,
      );
    },
  );

  it(
    'rejects an unrecognised trending window with InvalidProjectSquareWindowError',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      await expect(
        projectSquareService.listDirectory({ rank: 'trending', window: 'year' }),
      ).rejects.toBeInstanceOf(InvalidProjectSquareWindowError);
    },
  );

  it(
    'rejects a cursor minted under a DIFFERENT rank (a tab switch must restart)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const crossRank = encodeRankedCursor({
        rank: 'popular',
        window: null,
        score: 3,
        ts: null,
        id: 'abc123',
        search: null,
        category: null,
      });
      await expect(
        projectSquareService.listDirectory({ rank: 'recent', cursor: crossRank }),
      ).rejects.toBeInstanceOf(InvalidProjectSquareCursorError);
    },
  );
});

describe('ranked cursor codec', () => {
  it('round-trips a numeric (popular) keyset position', { timeout: PURE_TEST_TIMEOUT_MS }, () => {
    const c = decodeRankedCursor(
      encodeRankedCursor({
        rank: 'popular',
        window: null,
        score: 7,
        ts: null,
        id: 'abc',
        search: null,
        category: null,
      }),
    );
    expect(c).toEqual({
      rank: 'popular',
      window: null,
      score: 7,
      ts: null,
      id: 'abc',
      search: null,
      category: null,
    });
  });

  it('round-trips a timestamp (recent) keyset position', { timeout: PURE_TEST_TIMEOUT_MS }, () => {
    const iso = '2026-06-14T12:00:00.000Z';
    const c = decodeRankedCursor(
      encodeRankedCursor({
        rank: 'recent',
        window: null,
        score: null,
        ts: iso,
        id: 'xyz',
        search: null,
        category: null,
      }),
    );
    expect(c).toEqual({
      rank: 'recent',
      window: null,
      score: null,
      ts: iso,
      id: 'xyz',
      search: null,
      category: null,
    });
  });

  it(
    'round-trips a trending position carrying its window',
    { timeout: PURE_TEST_TIMEOUT_MS },
    () => {
      const c = decodeRankedCursor(
        encodeRankedCursor({
          rank: 'trending',
          window: 'day',
          score: 12,
          ts: null,
          id: 'q1',
          search: null,
          category: null,
        }),
      );
      expect(c).toEqual({
        rank: 'trending',
        window: 'day',
        score: 12,
        ts: null,
        id: 'q1',
        search: null,
        category: null,
      });
    },
  );

  it(
    'throws InvalidProjectSquareCursorError on malformed / mis-shaped tokens',
    { timeout: PURE_TEST_TIMEOUT_MS },
    () => {
      expect(() => decodeRankedCursor('not-a-valid-cursor')).toThrow(
        InvalidProjectSquareCursorError,
      );
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
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The guard that keeps the budgets above true for tests written LATER.
// ─────────────────────────────────────────────────────────────────────────────
describe('this file does not ride the global testTimeout (MOTIR-3167)', () => {
  it('EVERY test declares an explicit budget', { timeout: PURE_TEST_TIMEOUT_MS }, () => {
    // ⚠️ A SCAN, NOT A COUNT — MOTIR-2017's lesson, and the reason this file
    // needed fixing at all. Thirteen tests carrying a budget says nothing about
    // the fourteenth, and the fourteenth is how a real-Postgres keyset walk ends
    // up inside a 15 s timer nobody chose for it. Asserting over whatever is in
    // the source NOW is what makes a test added tomorrow inherit the rule.
    //
    // The budget belongs to the FILE, so the file reads itself: `__dirname` is
    // absent under Vitest's ESM transform, and `import.meta.url` is the form
    // that survives it.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const offenders = testsRidingTheDefaultTimeout(source, [
      'DB_TEST_TIMEOUT_MS',
      'PURE_TEST_TIMEOUT_MS',
    ]);

    expect(offenders, 'these tests inherit vitest.config.ts’s 15 s default').toEqual([]);
    // ...and it must not pass vacuously: there ARE tests here, and all of them
    // are bounded. A scan over an empty chunk list is green for the wrong reason.
    expect(scannedTestCount(source)).toBeGreaterThanOrEqual(13);
  });
});
