import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  ACCOUNT_ERASURE_WINDOW_DAYS,
  DATA_EXPORT_RETENTION_DAYS,
  dataExportExpiresAt,
  erasureDueAt,
} from '@/lib/users/dataSubjectRequests';
import { accountDeletionRequestRepository } from '@/lib/repositories/accountDeletionRequestRepository';
import { dataExportRequestRepository } from '@/lib/repositories/dataExportRequestRepository';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// The data-subject-request SUBSTRATE (Story 8.4 · Subtask MOTIR-3698) against a
// REAL Postgres — the repo's testing contract, and the only way to test what
// this card's criteria actually assert. The partial unique index, the RLS
// policy and the `FOR UPDATE` arm are all properties of the DATABASE; a mocked
// repository would assert that we called a function.
//
// `account_deletion_request` and `data_export_request` both FK against `user`
// with `ON DELETE CASCADE`, so `truncateAuthTables`'s existing `"user" …
// CASCADE` reaches them and no new truncate target is owed (the
// `legal_acceptance` precedent). Nothing here writes a table outside that
// cascade, so there is no `afterEach` clear to add either.

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeUser(email: string) {
  return adminDb.user.create({
    data: { email, name: email.split('@')[0]!, emailVerified: true },
  });
}

/** A rendezvous both racers reach before either writes. Without it
 *  `Promise.allSettled` does not overlap the attempts at all — the first
 *  transaction commits before the second has read, so the second is rejected
 *  correctly with or without the guard under test (MOTIR-3707). */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

describe('the erasure window is the published promise', () => {
  // ⚠️ THIS ASSERTION USED TO READ THE POLICY OFF DISK, AND IT CANNOT ANY MORE
  // (MOTIR-4103). It opened `content/legal/privacy.md`, pulled the retention
  // window out of §6 with a regex, and compared it with the constant below —
  // which failed in BOTH directions, an edit to the constant and an edit to the
  // copy alike. That is the strongest form this guard can take and it is not
  // available here now: the documents are moooon B.V.'s contract text and left
  // this GPL-3.0 repository with MOTIR-3909, so the file the regex read is in
  // `motir-marketing` and no test in this repository can open it.
  //
  // ⚠️ SO ONE HALF OF THE COUPLING IS UNGUARDED HERE, AND IT IS GUARDED THERE —
  // bug MOTIR-4233 built the policy-side half in the repository that has the
  // document:
  //
  //     motir-marketing  tests/legal/publishedRetentionWindow.test.ts
  //                      (PUBLISHED_ERASURE_WINDOW_DAYS)
  //
  // It reads the window out of §6 and pins it, so an edit to the POLICY goes red
  // there; the assertion below is the other half, so an edit to the CONSTANT
  // goes red here. Neither half can see its counterpart — that is the cost of
  // the documents living in another repository — so each one names the other,
  // and this comment is that naming. Until MOTIR-4233 merges, a policy edit
  // still passes silently; do not read the green below as the old guard.
  //
  // What survives is the half this repository can still assert: the constant is
  // pinned to the number the Privacy Policy publishes, quoted, so an edit to
  // `ACCOUNT_ERASURE_WINDOW_DAYS` alone still goes red and arrives here with the
  // published sentence in front of it.
  it('equals the number the published Privacy Policy §6 states to users', () => {
    // https://motir.co/legal/privacy §6 ("How long we keep it"), verbatim:
    //
    //   "After you delete it, we erase or anonymise within **30 days**, except
    //    where something below applies"
    //
    // §6 is a PROMISE, not documentation. If this line is failing, do not simply
    // update the literal: read the published §6 first, because the two are only
    // allowed to differ if the policy changed and somebody meant it.
    const PUBLISHED_ERASURE_WINDOW_DAYS = 30;
    expect(ACCOUNT_ERASURE_WINDOW_DAYS).toBe(PUBLISHED_ERASURE_WINDOW_DAYS);
  });

  it('derives the due date from the constant, not from a literal', () => {
    // The clock is OWNED here rather than sampled, so this is an equality and
    // not a window: `requestedAt` is injected, so the expected value is exact.
    const requestedAt = new Date('2026-08-27T13:33:51.000Z');
    expect(erasureDueAt(requestedAt).getTime()).toBe(
      requestedAt.getTime() + ACCOUNT_ERASURE_WINDOW_DAYS * DAY_MS,
    );
    // And it is genuinely the constant that moved the date — a literal 30 in the
    // helper would pass the line above too, so anchor it to the published number.
    expect(erasureDueAt(requestedAt).toISOString()).toBe('2026-09-26T13:33:51.000Z');
  });

  it('measures export retention from the BUILD, over seven days', () => {
    const builtAt = new Date('2026-08-27T09:00:00.000Z');
    expect(DATA_EXPORT_RETENTION_DAYS).toBe(7);
    expect(dataExportExpiresAt(builtAt).getTime()).toBe(
      builtAt.getTime() + DATA_EXPORT_RETENTION_DAYS * DAY_MS,
    );
  });
});

describe('the status columns are Postgres enums', () => {
  // The card's second criterion, asserted against the CATALOG rather than
  // against `schema.prisma`: the schema is a claim about the database and the
  // catalog is the fact. A `String` column would satisfy every TypeScript
  // `Record<Status, …>` in the consumers while the database held a value none of
  // them had heard of.
  async function columnType(table: string, column: string): Promise<string> {
    const rows = await adminDb.$queryRaw<Array<{ data_type: string; udt_name: string }>>`
      SELECT data_type, udt_name
        FROM information_schema.columns
       WHERE table_name = ${table} AND column_name = ${column}
    `;
    expect(rows).toHaveLength(1);
    return `${rows[0]!.data_type}:${rows[0]!.udt_name}`;
  }

  async function enumLabels(typeName: string): Promise<string[]> {
    const rows = await adminDb.$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = ${typeName}
       ORDER BY e.enumsortorder
    `;
    return rows.map((row) => row.label);
  }

  it('`account_deletion_request.status` is `account_deletion_status`, not a string', async () => {
    expect(await columnType('account_deletion_request', 'status')).toBe(
      'USER-DEFINED:account_deletion_status',
    );
    expect(await enumLabels('account_deletion_status')).toEqual([
      'scheduled',
      'cancelled',
      'completed',
    ]);
  });

  it('`data_export_request.status` is `data_export_status`, not a string', async () => {
    expect(await columnType('data_export_request', 'status')).toBe(
      'USER-DEFINED:data_export_status',
    );
    expect(await enumLabels('data_export_status')).toEqual([
      'preparing',
      'ready',
      'failed',
      'expired',
    ]);
  });
});

describe('accountDeletionRequestRepository', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('creates a request and reads it back through the owner policy', async () => {
    const user = await makeUser('creates@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');

    const created = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: user.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
        tx,
      ),
    );

    expect(created.status).toBe('scheduled');
    expect(created.cancelledAt).toBeNull();
    expect(created.completedAt).toBeNull();
    expect(created.erasureDueAt.getTime()).toBe(
      requestedAt.getTime() + ACCOUNT_ERASURE_WINDOW_DAYS * DAY_MS,
    );

    // Read BACK through the application's own path, not the return value.
    const open = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.findOpenByUserId(user.id, tx),
    );
    expect(open?.id).toBe(created.id);
  });

  it('locks the open row FOR UPDATE under the owner context', async () => {
    // ⚠️ THIS IS THE ARM PROBE, not a round-trip. Postgres applies the UPDATE
    // policy's `USING` to a `SELECT … FOR UPDATE`, and filters non-qualifying
    // rows out SILENTLY — so a table whose read arm fires for a caller and whose
    // update arm does not returns the row to `findOpenByUserId` and NOTHING to
    // this method, leaving the lock inert while every other signal says it works
    // (MOTIR-3707). A single `FOR ALL` policy is what makes the two agree, and
    // this asserts that it does.
    const user = await makeUser('locks@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');
    await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: user.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
        tx,
      ),
    );

    const locked = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.findOpenByUserIdForUpdate(user.id, tx),
    );
    expect(locked).not.toBeNull();
    expect(locked!.erasureDueAt.getTime()).toBe(erasureDueAt(requestedAt).getTime());
    expect(locked!.requestedAt.getTime()).toBe(requestedAt.getTime());
  });

  it('cancels a request, which takes it out of the open set', async () => {
    const user = await makeUser('cancels@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');
    const created = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: user.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
        tx,
      ),
    );

    const cancelledAt = new Date('2026-08-28T09:00:00.000Z');
    const updated = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.update(created.id, { status: 'cancelled', cancelledAt }, tx),
    );
    expect(updated.status).toBe('cancelled');
    expect(updated.cancelledAt?.getTime()).toBe(cancelledAt.getTime());

    const open = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.findOpenByUserId(user.id, tx),
    );
    expect(open).toBeNull();

    // …and the row is still THERE. A cancelled request is history, not a delete.
    expect(await adminDb.accountDeletionRequest.count({ where: { userId: user.id } })).toBe(1);
  });

  it('lets a cancelled request be followed by a second one', async () => {
    // The partial index constrains the OPEN set only — changing your mind twice
    // is allowed, and this is the case a plain `@@unique([userId])` would break.
    const user = await makeUser('second@example.com');
    const first = new Date('2026-08-01T10:00:00.000Z');
    const created = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: user.id, requestedAt: first, erasureDueAt: erasureDueAt(first) },
        tx,
      ),
    );
    await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.update(
        created.id,
        { status: 'cancelled', cancelledAt: new Date('2026-08-02T10:00:00.000Z') },
        tx,
      ),
    );

    const second = new Date('2026-08-27T10:00:00.000Z');
    const reopened = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: user.id, requestedAt: second, erasureDueAt: erasureDueAt(second) },
        tx,
      ),
    );
    expect(reopened.id).not.toBe(created.id);
    expect(await adminDb.accountDeletionRequest.count({ where: { userId: user.id } })).toBe(2);
  });

  it('refuses a SECOND open request for the same user', async () => {
    // The card's third criterion, in its simplest (serial) form. The
    // concurrency test below is what proves the index rather than the ordering
    // is doing the work.
    const user = await makeUser('duplicate@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');
    const open = () =>
      withUserContext(user.id, (tx) =>
        accountDeletionRequestRepository.create(
          { userId: user.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
          tx,
        ),
      );

    await open();
    await expect(open()).rejects.toMatchObject({ code: 'P2002' });
    expect(await adminDb.accountDeletionRequest.count({ where: { userId: user.id } })).toBe(1);
  });

  it('is not confused by ANOTHER user holding an open request', async () => {
    const alice = await makeUser('alice-open@example.com');
    const bob = await makeUser('bob-open@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');
    const input = (userId: string) => ({
      userId,
      requestedAt,
      erasureDueAt: erasureDueAt(requestedAt),
    });

    await withUserContext(alice.id, (tx) =>
      accountDeletionRequestRepository.create(input(alice.id), tx),
    );
    await withUserContext(bob.id, (tx) =>
      accountDeletionRequestRepository.create(input(bob.id), tx),
    );

    expect(await adminDb.accountDeletionRequest.count()).toBe(2);
  });
});

describe('opening a deletion request is race-safe', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  // THE REAL-CONCURRENCY TEST (the card's sixth criterion), and it is written to
  // fail without the INDEX rather than to pass on a cold pool.
  //
  // ⚠️ WHY THE LOCK IS NOT WHAT IS BEING TESTED. `SELECT … FOR UPDATE`
  // serialises writers only over a row that ALREADY EXISTS. On a user's FIRST
  // request the predicate matches ZERO rows, so it locks nothing and every racer
  // falls through the guard together — which is exactly what this test ASSERTS
  // (`bothSawNothing`), because a run in which one racer saw the other's row
  // would be a run that never exercised the index at all.
  //
  // ⚠️ AND ONE ROUND TESTS THE RARE PATH. The two losing paths are not equally
  // likely; a single round has gone green locally and red in CI. Five rounds,
  // with the precondition reset between them, exercise the FIRST race every
  // time.
  it('lets exactly one of two simultaneous attempts through, five times over', async () => {
    const user = await makeUser('race@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');

    for (let round = 0; round < 5; round += 1) {
      await adminDb.accountDeletionRequest.deleteMany({ where: { userId: user.id } });

      const arrive = barrier(2);
      const sawOpen: Array<unknown> = [];

      const attempt = () =>
        withUserContext(user.id, async (tx) => {
          // The guard the service will run: is there already an open request?
          sawOpen.push(
            await accountDeletionRequestRepository.findOpenByUserIdForUpdate(user.id, tx),
          );
          // Hold BOTH transactions open past that read, so neither can have
          // committed before the other looked.
          await arrive();
          return accountDeletionRequestRepository.create(
            { userId: user.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
            tx,
          );
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // ORDER MATTERS: report WHICH way it broke. Two fulfilled means the index
      // did not hold and the user now has two open requests; two rejected means
      // the round never ran the race it claims to.
      expect(
        fulfilled.length,
        `round ${round}: expected exactly one winner, got ${fulfilled.length} fulfilled / ${rejected.length} rejected`,
      ).toBe(1);
      expect(rejected).toHaveLength(1);

      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((reason as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

      // The point of the barrier: both racers read an EMPTY open set, so the row
      // lock caught neither of them and the unique index is demonstrably the
      // thing that rejected the loser.
      expect(
        sawOpen,
        `round ${round}: a racer saw the other's row, so this round did not exercise the first-write race`,
      ).toEqual([null, null]);

      expect(await adminDb.accountDeletionRequest.count({ where: { userId: user.id } })).toBe(1);
    }
  });
});

describe('dataExportRequestRepository', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('creates a preparing request and reads the latest one back', async () => {
    const user = await makeUser('export@example.com');

    const older = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.create(
        { userId: user.id, requestedAt: new Date('2026-08-01T10:00:00.000Z') },
        tx,
      ),
    );
    const newer = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.create(
        { userId: user.id, requestedAt: new Date('2026-08-27T10:00:00.000Z') },
        tx,
      ),
    );

    expect(newer.status).toBe('preparing');
    expect(newer.blobPathname).toBeNull();
    expect(newer.builtAt).toBeNull();
    expect(newer.expiresAt).toBeNull();
    expect(newer.failureReason).toBeNull();

    const latest = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.findLatestByUserId(user.id, tx),
    );
    expect(latest?.id).toBe(newer.id);
    expect(latest?.id).not.toBe(older.id);
  });

  it('locks the latest row FOR UPDATE under the owner context', async () => {
    const user = await makeUser('export-lock@example.com');
    const created = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.create(
        { userId: user.id, requestedAt: new Date('2026-08-27T10:00:00.000Z') },
        tx,
      ),
    );

    const locked = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.findLatestByUserIdForUpdate(user.id, tx),
    );
    expect(locked).toEqual({ id: created.id, status: 'preparing', builtAt: null });
  });

  it('records a successful build, with the expiry derived from `builtAt`', async () => {
    const user = await makeUser('export-ready@example.com');
    const created = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.create(
        { userId: user.id, requestedAt: new Date('2026-08-27T10:00:00.000Z') },
        tx,
      ),
    );

    const builtAt = new Date('2026-08-27T10:04:00.000Z');
    const ready = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.update(
        created.id,
        {
          status: 'ready',
          blobPathname: `exports/${user.id}/motir-export-2026-08-27.zip`,
          builtAt,
          expiresAt: dataExportExpiresAt(builtAt),
        },
        tx,
      ),
    );

    expect(ready.status).toBe('ready');
    expect(ready.expiresAt?.getTime()).toBe(
      builtAt.getTime() + DATA_EXPORT_RETENTION_DAYS * DAY_MS,
    );
    expect(ready.blobPathname).toContain('motir-export');
  });

  it('records a failure, and an expiry that clears the blob pointer', async () => {
    const user = await makeUser('export-failed@example.com');
    const created = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.create(
        { userId: user.id, requestedAt: new Date('2026-08-27T10:00:00.000Z') },
        tx,
      ),
    );

    const failed = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.update(
        created.id,
        { status: 'failed', failureReason: 'blob upload rejected: 413' },
        tx,
      ),
    );
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('blob upload rejected: 413');

    // The expiry sweep's write — the row survives so the pane can say what
    // happened, and the pointer goes because the object is gone.
    const expired = await withUserContext(user.id, (tx) =>
      dataExportRequestRepository.update(created.id, { status: 'expired', blobPathname: null }, tx),
    );
    expect(expired.status).toBe('expired');
    expect(expired.blobPathname).toBeNull();
  });
});

describe('row-level security', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('hides one account holder’s requests from another', async () => {
    const alice = await makeUser('rls-alice@example.com');
    const mallory = await makeUser('rls-mallory@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');

    await withUserContext(alice.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: alice.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
        tx,
      ),
    );
    await withUserContext(alice.id, (tx) =>
      dataExportRequestRepository.create({ userId: alice.id, requestedAt }, tx),
    );

    // Bound to Mallory, Alice's rows do not exist — including through the
    // locking read, whose arm is the one it is easiest to get wrong.
    const seen = await withUserContext(mallory.id, async (tx) => ({
      deletion: await accountDeletionRequestRepository.findOpenByUserId(alice.id, tx),
      deletionLocked: await accountDeletionRequestRepository.findOpenByUserIdForUpdate(
        alice.id,
        tx,
      ),
      exportRow: await dataExportRequestRepository.findLatestByUserId(alice.id, tx),
      exportLocked: await dataExportRequestRepository.findLatestByUserIdForUpdate(alice.id, tx),
    }));
    expect(seen).toEqual({
      deletion: null,
      deletionLocked: null,
      exportRow: null,
      exportLocked: null,
    });

    // The rows are really there — the emptiness above is the policy, not a
    // fixture that failed to write.
    expect(await adminDb.accountDeletionRequest.count({ where: { userId: alice.id } })).toBe(1);
    expect(await adminDb.dataExportRequest.count({ where: { userId: alice.id } })).toBe(1);
  });

  it('admits the userless sweeps through the system arm', async () => {
    // The erasure sweep (MOTIR-3702) and the export build (MOTIR-3701) run with
    // nobody signed in. Without this arm their reads return zero rows and RAISE
    // NOTHING, so a due erasure would read as "there is nothing to erase".
    const user = await makeUser('sweep@example.com');
    const requestedAt = new Date('2026-08-27T10:00:00.000Z');
    const created = await withUserContext(user.id, (tx) =>
      accountDeletionRequestRepository.create(
        { userId: user.id, requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
        tx,
      ),
    );

    const swept = await withSystemContext(async (tx) => {
      const locked = await accountDeletionRequestRepository.findOpenByUserIdForUpdate(user.id, tx);
      expect(locked?.id).toBe(created.id);
      return accountDeletionRequestRepository.update(
        created.id,
        { status: 'completed', completedAt: new Date('2026-09-26T13:33:51.000Z') },
        tx,
      );
    });

    expect(swept.status).toBe('completed');
    expect(
      await adminDb.accountDeletionRequest.count({
        where: { userId: user.id, status: 'completed' },
      }),
    ).toBe(1);
  });
});

describe('only repositories reach these two tables', () => {
  // The card's fifth criterion, as a GUARD rather than as an observation. It is
  // true today by construction — nothing but the two repositories exists yet —
  // and the whole point of the criterion is that it stays true once 8.4.18–8.4.23
  // land on top of this substrate. A service or a route that addresses
  // `tx.accountDeletionRequest` directly is a 4-layer violation the day it is
  // written, and the day it is written is the only cheap moment to say so.
  //
  // The scan is for the PRISMA MODEL ACCESSOR, not for the table name: every way
  // of reaching these rows through the client goes through `.accountDeletionRequest`
  // / `.dataExportRequest` on a client or a transaction, whichever identifier the
  // author happened to give it. Raw SQL naming the table is a separate shape and
  // is caught by `tests/rls/` — `contextArmScan` walks `lib` and `app` for it.
  const ACCESSORS = /\.(accountDeletionRequest|dataExportRequest)\b/;
  const SOURCE_DIRS = ['lib', 'app', 'components', 'scripts'];
  const ALLOWED_PREFIX = path.join('lib', 'repositories') + path.sep;

  function sourceFiles(dir: string): string[] {
    const absolute = path.join(REPO_ROOT, dir);
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = path.join(current, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(path.relative(REPO_ROOT, full));
      }
    };
    walk(absolute);
    return out;
  }

  it('no file outside `lib/repositories/` addresses either model', () => {
    const offenders = SOURCE_DIRS.flatMap(sourceFiles)
      .filter((file) => !file.startsWith(ALLOWED_PREFIX))
      .filter((file) =>
        ACCESSORS.test(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))),
      );

    expect(
      offenders,
      'these files reach `account_deletion_request` / `data_export_request` through Prisma ' +
        'directly — the 4-layer contract puts that access in `lib/repositories/`',
    ).toEqual([]);
  });

  it('the two repositories that ARE allowed to exist, do', () => {
    // The mirror assertion: an empty offender list is also what a scan that
    // walks nothing returns, so prove the walk reaches the files it must.
    const found = sourceFiles('lib').filter((file) =>
      ACCESSORS.test(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))),
    );
    expect(found.sort()).toEqual([
      path.join('lib', 'repositories', 'accountDeletionRequestRepository.ts'),
      path.join('lib', 'repositories', 'dataExportRequestRepository.ts'),
    ]);
  });
});
