import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { accountDeletionRequestRepository } from '@/lib/repositories/accountDeletionRequestRepository';
import { accountErasureService } from '@/lib/services/accountErasureService';
import { sessionRepository } from '@/lib/repositories/sessionRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ACCOUNT_ERASURE_WINDOW_DAYS, erasureDueAt } from '@/lib/users/dataSubjectRequests';
import {
  AccountDeletionAlreadyCompletedError,
  AccountDeletionAlreadyScheduledError,
  AccountDeletionBlockedError,
  NoOpenAccountDeletionRequestError,
} from '@/lib/users/errors';
import { TEST_PASSWORD, createTestUser } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { warmPool } from './helpers/warmPool';

// Scheduling and cancelling an account deletion (Story 8.4 · Subtask
// MOTIR-3700) — `accountDeletionService`, against the real Postgres.
//
// The sibling suite `account-erasure-preview.test.ts` covers the READ half; this
// is the WRITE. Design of record: `design/settings/design-notes.md` →
// `Data & privacy` → DECISION 4 (deletion SCHEDULES, it does not fire; the
// window is 30 days; signing in cancels it) and DECISION 5 (the block is the
// ORGANIZATION).
//
// Five things this suite pins, and three of them are properties of HOW rather
// than of WHAT — which is why the probe below exists:
//
//   1. the row: exactly one `scheduled` request, its deadline derived from the
//      published constant and never retyped;
//   2. the REFUSALS, each as a typed domain error — the organization block, a
//      second request, a cancel with nothing open, a cancel after the erasure;
//   3. the RACE: two simultaneous schedules leave ONE row and the loser is told
//      so in the domain's own words, not in Prisma's;
//   4. the SEAM: signing in cancels, asserted through `auth.api.signInEmail`
//      rather than by calling the service — the placement is the property;
//   5. the SHAPE: the sign-out is a post-commit side effect, so it is NOT in the
//      transaction that decides the deletion, and its failure does not undo one.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The transaction probe ────────────────────────────────────────────────────
//
// The card's last-but-one criterion — *"No external side effect runs inside the
// `$transaction`, asserted by the transaction's own contents"* — is not a
// statement about the returned value, so an expectation cannot reach it. This
// records what each `db.$transaction` call actually did, in order, and lets a
// test say which transaction a given write landed in.
//
// ⚠️ IT WRAPS `$transaction` AND NOTHING ELSE. `tests/account-erasure-preview`
// records the reason at length and it applies verbatim here: replacing
// `db.$executeRaw` on the SINGLETON makes `withUserContext`'s own
// `SELECT set_config('app.user_id', …)` run outside the transaction it was
// meant to bind, every RLS policy then reads NULL, and the suite measures a
// service that can no longer see its own rows. The raw statements this probe
// does observe are the ones issued ON the transaction client, which is where
// both the `set_config` and the `FOR UPDATE` legitimately live.

const WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
] as const;

const RAW_METHODS = ['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe'] as const;

/** One `db.$transaction` call, and everything that happened inside it. */
interface RecordedTransaction {
  /** `<model>.<method>` for every write attempted on this transaction's client. */
  writes: string[];
  /** The text of every raw statement issued on this transaction's client. */
  rawSql: string[];
}

interface TransactionProbe<T> {
  result: T;
  /** In the order the transactions OPENED. */
  transactions: RecordedTransaction[];
}

/** The slice of a vitest spy this file uses — `vi.spyOn` on a Prisma delegate
 *  types as `never`, which is why the cast goes through `unknown`. */
interface Spy {
  mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
  mockRestore: () => void;
}

/** Render a tagged-template / `Prisma.Sql` / string argument as its SQL text. */
function sqlText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg)) return arg.join('?');
  if (arg && typeof arg === 'object' && 'strings' in arg) {
    return (arg as { strings: string[] }).strings.join('?');
  }
  if (arg && typeof arg === 'object' && 'sql' in arg) return String((arg as { sql: unknown }).sql);
  return String(arg);
}

async function probeTransactions<T>(fn: () => Promise<T>): Promise<TransactionProbe<T>> {
  const transactions: RecordedTransaction[] = [];

  const wrap = (client: Prisma.TransactionClient, record: RecordedTransaction) =>
    new Proxy(client as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== 'string') return value;
        if ((RAW_METHODS as readonly string[]).includes(prop) && typeof value === 'function') {
          return (...args: unknown[]) => {
            record.rawSql.push(sqlText(args[0]));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (value === null || typeof value !== 'object' || prop.startsWith('$')) return value;
        return new Proxy(value as object, {
          get(delegate, method, delegateReceiver) {
            const fnValue = Reflect.get(delegate, method, delegateReceiver) as unknown;
            if (typeof method !== 'string' || typeof fnValue !== 'function') return fnValue;
            if (!(WRITE_METHODS as readonly string[]).includes(method)) return fnValue;
            return (...args: unknown[]) => {
              record.writes.push(`${prop}.${method}`);
              return (fnValue as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      },
    }) as Prisma.TransactionClient;

  const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  const txSpy = vi.spyOn(db, '$transaction') as unknown as Spy;
  txSpy.mockImplementation((...args: unknown[]) => {
    const [first, ...rest] = args;
    // The ARRAY form (`db.$transaction([...])`) carries no client to wrap.
    if (typeof first !== 'function') return realTransaction(...args);
    const record: RecordedTransaction = { writes: [], rawSql: [] };
    transactions.push(record);
    const callback = first as (tx: Prisma.TransactionClient) => Promise<unknown>;
    return realTransaction((tx: Prisma.TransactionClient) => callback(wrap(tx, record)), ...rest);
  });

  try {
    const result = await fn();
    return { result, transactions };
  } finally {
    txSpy.mockRestore();
  }
}

/** Index into an array where the test has already asserted its length —
 *  `noUncheckedIndexedAccess` is on, and a bare `[0]` is `T | undefined`. */
function at<T>(items: T[], index = 0): T {
  const value = items[index];
  if (value === undefined) throw new Error(`no element at index ${index}`);
  return value;
}

/** Rows for this user, read past RLS — the ground truth every count uses. */
function requestsOf(userId: string) {
  return adminDb.accountDeletionRequest.findMany({
    where: { userId },
    orderBy: { requestedAt: 'asc' },
  });
}

/** A user who is the ONLY owner of an organization somebody else belongs to —
 *  DECISION 5's hard block, built exactly as the preview suite builds it. */
async function blockedUser() {
  const user = await createTestUser();
  const colleague = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  await organizationsService.addMember({
    organizationId: ws.organizationId,
    userId: colleague.id,
    role: 'member',
    actorUserId: user.id,
  });
  return user;
}

describe('scheduleAccountDeletion — the row and its deadline', () => {
  it('writes exactly one `scheduled` request and returns the due date the copy interpolates', async () => {
    const user = await createTestUser();

    const scheduled = await accountDeletionService.scheduleAccountDeletion(user.id);

    const rows = await requestsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(at(rows).status).toBe('scheduled');
    expect(at(rows).cancelledAt).toBeNull();
    expect(at(rows).completedAt).toBeNull();

    expect(scheduled.status).toBe('scheduled');
    // ⚠️ THE DEADLINE IS DERIVED, NOT TYPED. Asserted against the vocabulary
    // module's own function rather than against a hand-computed date: if the
    // published window in `content/legal/privacy.md` §6 ever moves, this test
    // must move WITH the constant, not fail beside it.
    expect(scheduled.erasureDueAt).toBe(
      erasureDueAt(new Date(scheduled.requestedAt)).toISOString(),
    );
    expect(at(rows).erasureDueAt).toEqual(erasureDueAt(at(rows).requestedAt));
  });

  it('is the published window measured from the REQUEST, so the deadline never moves', async () => {
    const user = await createTestUser();

    const scheduled = await accountDeletionService.scheduleAccountDeletion(user.id);

    const elapsedDays =
      (new Date(scheduled.erasureDueAt).getTime() - new Date(scheduled.requestedAt).getTime()) /
      (24 * 60 * 60 * 1000);
    expect(elapsedDays).toBe(ACCOUNT_ERASURE_WINDOW_DAYS);
  });

  it('⚠️ never retypes the number — the service source carries no bare `30`', () => {
    // `content/legal/privacy.md` §6 promises erasure "within 30 days" and
    // `ACCOUNT_ERASURE_WINDOW_DAYS` is the one place that number lives, so the
    // promise and the behaviour cannot drift. A second copy in this service
    // would behave identically today and drift silently on the day §6 changes —
    // which is precisely the failure a behavioural test cannot see.
    const source = readFileSync('lib/services/accountDeletionService.ts', 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).toContain('erasureDueAt(requestedAt)');
    expect(code).not.toMatch(/\b30\b/);
  });
});

describe('scheduleAccountDeletion — the refusals', () => {
  it('refuses the last owner of a shared organization, and writes NO row', async () => {
    const user = await blockedUser();

    await expect(accountDeletionService.scheduleAccountDeletion(user.id)).rejects.toBeInstanceOf(
      AccountDeletionBlockedError,
    );

    // The point of DECISION 5 is that the reader meets the refusal at rest,
    // never after committing to it — so nothing may be left behind by the
    // attempt either.
    expect(await requestsOf(user.id)).toHaveLength(0);
  });

  it('names the organization in the refusal, because the way out is inside it', async () => {
    const user = await blockedUser();

    const err: unknown = await accountDeletionService
      .scheduleAccountDeletion(user.id)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AccountDeletionBlockedError);
    const blocked = err as AccountDeletionBlockedError;
    expect(blocked.organizationName).toBe('Acme');
    expect(blocked.message).toContain('Acme');
  });

  it('refuses a SECOND request while one is open, and still leaves exactly one row', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);

    await expect(accountDeletionService.scheduleAccountDeletion(user.id)).rejects.toBeInstanceOf(
      AccountDeletionAlreadyScheduledError,
    );
    expect(await requestsOf(user.id)).toHaveLength(1);
  });

  it('lets a CANCELLED request be followed by a new one — cancelling does not close the door', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    await accountDeletionService.cancelAccountDeletion(user.id);

    const second = await accountDeletionService.scheduleAccountDeletion(user.id);

    expect(second.status).toBe('scheduled');
    const rows = await requestsOf(user.id);
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'scheduled']);
  });
});

describe('cancelAccountDeletion', () => {
  it('moves an open request to `cancelled` and stamps when', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);

    const cancelled = await accountDeletionService.cancelAccountDeletion(user.id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();
    const rows = await requestsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(at(rows).status).toBe('cancelled');
    // The deadline is left exactly where it was: a cancelled request is a
    // record of what WOULD have happened, and moving its date would rewrite it.
    expect(at(rows).erasureDueAt).toEqual(erasureDueAt(at(rows).requestedAt));
  });

  it('refuses a request that has already `completed` — and says so, rather than "nothing scheduled"', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    const row = at(await requestsOf(user.id));
    await adminDb.accountDeletionRequest.update({
      where: { id: row.id },
      data: { status: 'completed', completedAt: new Date() },
    });

    // ⚠️ THE TWO ANSWERS ARE OPPOSITE. "You have nothing scheduled" tells
    // somebody whose data is already gone that they are fine; the erasure ran.
    await expect(accountDeletionService.cancelAccountDeletion(user.id)).rejects.toBeInstanceOf(
      AccountDeletionAlreadyCompletedError,
    );
  });

  it('refuses when nothing is scheduled at all', async () => {
    const user = await createTestUser();

    await expect(accountDeletionService.cancelAccountDeletion(user.id)).rejects.toBeInstanceOf(
      NoOpenAccountDeletionRequestError,
    );
  });

  it('refuses a second cancel of the same request', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    await accountDeletionService.cancelAccountDeletion(user.id);

    await expect(accountDeletionService.cancelAccountDeletion(user.id)).rejects.toBeInstanceOf(
      NoOpenAccountDeletionRequestError,
    );
  });
});

describe('the RACE — two schedules for one account, at the same moment', () => {
  it('leaves exactly one row, and the loser is told in the domain’s words', async () => {
    const user = await createTestUser();
    // ⚠️ A COLD POOL SERIALISES THE RACERS AND THE TEST PASSES REGARDLESS.
    // `warmPool` forces real concurrent connections so the DATABASE — the
    // partial unique index — is the only thing separating the two callers.
    await warmPool();

    const outcomes = await Promise.allSettled([
      accountDeletionService.scheduleAccountDeletion(user.id),
      accountDeletionService.scheduleAccountDeletion(user.id),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // ⚠️ NOT A `P2002`. The `FOR UPDATE` read inside the transaction cannot
    // serialise the FIRST insert — it locks a predicate matching zero rows — so
    // the partial unique index is what actually holds the line here, and the
    // service's whole job on this path is to turn its raw refusal into the same
    // typed error the in-transaction guard raises.
    const reason = (at(rejected) as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(AccountDeletionAlreadyScheduledError);
    expect(reason.constructor.name).not.toBe('PrismaClientKnownRequestError');
    expect(JSON.stringify(reason.message)).not.toContain('P2002');

    const rows = await requestsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(at(rows).status).toBe('scheduled');
  });

  it('translates the partial unique index’s own refusal — the arm the lock cannot reach', async () => {
    // ⚠️ THE REAL RACE ABOVE DOES NOT RELIABLY TAKE THIS PATH, and that is the
    // reason this test exists rather than a duplicate of it. Whether the loser
    // is stopped by the in-transaction `FOR UPDATE` read or by the index is a
    // matter of interleaving; on a quiet box the read wins every time, so the
    // translation of `P2002` — the arm that fires when both racers fall through
    // the read together, because a lock over zero rows locks nothing — would go
    // unexercised while the suite reported a passing race.
    //
    // Forcing the read to answer `null` reproduces exactly that interleaving:
    // the row exists, the guard does not see it, and the database refuses the
    // insert. What must come back is the domain's error, never Prisma's.
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    const spy = vi
      .spyOn(accountDeletionRequestRepository, 'findOpenByUserIdForUpdate')
      .mockResolvedValue(null);
    try {
      const err: unknown = await accountDeletionService
        .scheduleAccountDeletion(user.id)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AccountDeletionAlreadyScheduledError);
      expect(err).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(await requestsOf(user.id)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('serialises two simultaneous CANCELS onto one request', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    await warmPool();

    const outcomes = await Promise.allSettled([
      accountDeletionService.cancelAccountDeletion(user.id),
      accountDeletionService.cancelAccountDeletion(user.id),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    // ⚠️ THE LOSER SEES THE ROW WITH ITS NEW STATUS, not an empty result set.
    // The cancel path locks on `user_id` alone precisely so that READ
    // COMMITTED's re-evaluation of a waiting `FOR UPDATE` cannot filter the row
    // it just waited for out from under it.
    expect(rejected.reason).toBeInstanceOf(NoOpenAccountDeletionRequestError);
    expect((await requestsOf(user.id)).map((r) => r.status)).toEqual(['cancelled']);
  });
});

describe('the SIGN-OUT — a post-commit side effect, outside the deciding transaction', () => {
  it('signs every device out', async () => {
    const user = await createTestUser();
    await auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } });
    await auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } });
    expect(await sessionRepository.countByUserId(user.id)).toBeGreaterThan(0);

    await accountDeletionService.scheduleAccountDeletion(user.id);

    expect(await sessionRepository.countByUserId(user.id)).toBe(0);
  });

  it('⚠️ still schedules — and keeps the row — when signing out THROWS', async () => {
    const user = await createTestUser();
    // The failure is injected at the repository rather than simulated in the
    // database, because what is under test is the SERVICE's disposition of it:
    // a durable decision must not be discarded because a consequence of it
    // failed. (The alternative — coupling the two — reverts a deletion the
    // reader asked for and was told had been recorded.)
    const spy = vi
      .spyOn(sessionRepository, 'deleteAllForUser')
      .mockRejectedValue(new Error('session store unreachable'));
    try {
      const scheduled = await accountDeletionService.scheduleAccountDeletion(user.id);

      expect(scheduled.status).toBe('scheduled');
      const rows = await requestsOf(user.id);
      expect(rows).toHaveLength(1);
      expect(at(rows).status).toBe('scheduled');
    } finally {
      spy.mockRestore();
    }
  });

  it('⚠️ is NOT inside the transaction that decides the deletion', async () => {
    const user = await createTestUser();
    await auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } });

    const { transactions } = await probeTransactions(() =>
      accountDeletionService.scheduleAccountDeletion(user.id),
    );

    const deciding = transactions.filter((t) =>
      t.writes.some((w) => w.startsWith('accountDeletionRequest.')),
    );
    expect(deciding).toHaveLength(1);

    // The deciding transaction holds the DB writes the decision consists of and
    // NOTHING else: no session delete, no mail, no cross-domain write.
    expect(at(deciding).writes).toEqual(['accountDeletionRequest.create']);
    // …and it did bind its RLS context and take its lock, so this is a
    // transaction that ran rather than one the probe failed to observe.
    expect(at(deciding).rawSql.join(' ')).toContain('set_config');
    expect(at(deciding).rawSql.join(' ')).toContain('FOR UPDATE');

    // The sign-out happened, in a LATER transaction of its own.
    const signOut = transactions.filter((t) => t.writes.includes('session.deleteMany'));
    expect(signOut).toHaveLength(1);
    expect(transactions.indexOf(at(signOut))).toBeGreaterThan(transactions.indexOf(at(deciding)));
  });
});

describe('the defensive arms — what is NOT translated, and what is', () => {
  it('lets a NON-unique Prisma failure through untranslated', () => {
    // ⚠️ ONLY `P2002` MEANS "already scheduled". A catch that swallowed every
    // Prisma error into the same domain type would tell a reader their deletion
    // was already scheduled when the database had in fact refused the write for
    // an unrelated reason — and no row would exist to back the claim.
    const foreign = new Prisma.PrismaClientKnownRequestError('foreign key violation', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const spy = vi
      .spyOn(accountDeletionRequestRepository, 'create')
      .mockRejectedValue(foreign as never);

    return createTestUser()
      .then(async (user) => {
        const err: unknown = await accountDeletionService
          .scheduleAccountDeletion(user.id)
          .then(() => null)
          .catch((e: unknown) => e);

        expect(err).not.toBeInstanceOf(AccountDeletionAlreadyScheduledError);
        expect(err).toBe(foreign);
        expect(await requestsOf(user.id)).toHaveLength(0);
      })
      .finally(() => spy.mockRestore());
  });

  it('still names something when the preview blocks without naming an organization', async () => {
    // The DTO's own contract is that `blocked: true` carries a
    // `blockingOrganization`, and the type system cannot say so. The fallback is
    // what keeps a refusal READABLE if that invariant is ever broken — an empty
    // name in the middle of a sentence is worse than a generic one.
    const spy = vi.spyOn(accountErasureService, 'previewAccountErasure').mockResolvedValue({
      blocked: true,
      blockingOrganization: null,
      deleted: {
        credentials: 0,
        passkeys: 0,
        twoFactorEnrolments: 0,
        apiTokens: 0,
        dataExports: 0,
        soleMemberWorkspaces: [],
        projects: 0,
        workItems: 0,
      },
      anonymised: { comments: 0, workItems: 0 },
      kept: [],
    });
    try {
      const user = await createTestUser();

      const err: unknown = await accountDeletionService
        .scheduleAccountDeletion(user.id)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AccountDeletionBlockedError);
      expect((err as AccountDeletionBlockedError).organizationName).toBe('an organization');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('signing in cancels it — the seam, not the service', () => {
  it('cancels an open request on a successful sign-in, through the session path', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    expect(at(await requestsOf(user.id)).status).toBe('scheduled');

    // ⚠️ THROUGH `auth.api.signInEmail`, NOT through the service. The card asks
    // for this end-to-end because the risk is the PLACEMENT: a cancel that
    // works when called directly proves nothing about whether signing in
    // reaches it.
    await auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } });

    const rows = await requestsOf(user.id);
    expect(rows).toHaveLength(1);
    expect(at(rows).status).toBe('cancelled');
    expect(at(rows).cancelledAt).not.toBeNull();
  });

  it('leaves an ordinary sign-in alone — nothing scheduled, nothing written', async () => {
    const user = await createTestUser();

    await auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } });

    expect(await requestsOf(user.id)).toHaveLength(0);
  });

  it('does not resurrect a `completed` erasure, and does not fail the sign-in over it', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    const row = at(await requestsOf(user.id));
    await adminDb.accountDeletionRequest.update({
      where: { id: row.id },
      data: { status: 'completed', completedAt: new Date() },
    });

    await expect(
      auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } }),
    ).resolves.toBeDefined();

    expect(at(await requestsOf(user.id)).status).toBe('completed');
  });

  it('⚠️ does not fail the sign-in when the cancel itself throws', async () => {
    // Better-Auth runs `create.after` once the session is durable, so a throw
    // here cannot un-create it — it would only 500 a person who is, at that
    // moment, trying to rescue their account. The failure degrades to one extra
    // screen: they are signed in, the request is still `scheduled`, and
    // MOTIR-3704's app-wide banner offers `Cancel deletion` on every page.
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    const spy = vi
      .spyOn(accountDeletionService, 'cancelAccountDeletionIfScheduled')
      .mockRejectedValue(new Error('deletion store unreachable'));
    try {
      await expect(
        auth.api.signInEmail({ body: { email: user.email, password: TEST_PASSWORD } }),
      ).resolves.toBeDefined();

      expect(at(await requestsOf(user.id)).status).toBe('scheduled');
    } finally {
      spy.mockRestore();
    }
  });

  it('hangs off `session.create.after` — the ONE seam every sign-in path ends at', () => {
    // A structural assertion, for the reason `accountSuspension.test.ts` gives
    // for its twin: every alternative placement BEHAVES correctly for the path
    // it covers. A cancel moved onto `signInEmail` passes every behavioural
    // test above and leaves a deletion standing for somebody who came back
    // through Google or through `motir login` — and they would then be erased
    // on day 30 having signed in and seen the product working.
    const source = readFileSync('lib/auth/index.ts', 'utf8');
    expect(source).toMatch(/session:\s*\{\s*create:\s*\{[\s\S]*?after:/);
    expect(source).toContain('cancelDeletionOnSignIn(session.userId)');
  });
});

describe('findOpenDeletion', () => {
  it('returns the open request, and null once it is cancelled', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);

    const open = await accountDeletionService.findOpenDeletion(user.id);
    expect(open?.status).toBe('scheduled');

    await accountDeletionService.cancelAccountDeletion(user.id);
    expect(await accountDeletionService.findOpenDeletion(user.id)).toBeNull();
  });

  it('reads inside a bound transaction — an unbound read returns zero rows silently', async () => {
    // ⚠️ THE FAILURE THIS PINS IS A LIE, NOT AN ERROR. `account_deletion_request`
    // is RLS-gated on `app.user_id`; on the `db` singleton that GUC is unbound,
    // the policy predicate is NULL, and the read returns NOTHING while raising
    // nothing — which on this surface means telling somebody their account is
    // not being erased when it is.
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);

    const { transactions } = await probeTransactions(() =>
      accountDeletionService.findOpenDeletion(user.id),
    );

    expect(transactions).toHaveLength(1);
    expect(at(transactions).rawSql.join(' ')).toContain('set_config');
  });
});

describe('the repository lock the cancel path derives from', () => {
  it('hands back the LATEST row whatever its status — the predicate is `user_id` alone', async () => {
    const user = await createTestUser();
    await accountDeletionService.scheduleAccountDeletion(user.id);
    await accountDeletionService.cancelAccountDeletion(user.id);

    const latest = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
      return accountDeletionRequestRepository.findLatestByUserIdForUpdate(user.id, tx);
    });

    // `findOpenByUserIdForUpdate` would answer `null` here — which is exactly
    // the ambiguity the cancel path may not inherit.
    expect(latest?.status).toBe('cancelled');
  });
});
