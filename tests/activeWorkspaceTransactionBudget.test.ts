import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { Prisma } from '@/generated/prisma/client';
import { db, dbPool } from '@/lib/db';
import { transactionTimeoutHalf } from '@/lib/monitoring/transactionStall';
import { retryOnceOnTransactionStartTimeout } from '@/lib/workspaces/transactionStartRetry';
import { usersService } from '@/lib/services/usersService';
import { workspacesService, ACTIVE_WORKSPACE_RESOLVE_TX } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-6253 — THE ACTIVE-WORKSPACE RESOLVER DIED ON PRISMA'S 5 s BUDGET WHILE
// DOING NO WORK.
//
// Observed in production four times between 2026-08-30 and 2026-09-24, on
// `GET /api/workbench/stream`, as a `P2028` — *A query cannot be executed on an
// expired transaction. The timeout for this transaction was 5000 ms, however
// 30459 ms passed* — at `workspaceRepository.findByIdInTx`, the first read of
// `organizationsService.resolveWorkspaceAccess`, reached from the COOKIE-PIN
// branch of `workspacesService.resolveActiveWorkspace` (line 452 at the event's
// release, `dad249b22`). That transaction is `set_config` plus a handful of
// indexed reads and holds no lock. It cannot take 30 s by working; it can only
// take 30 s by WAITING.
//
// "QUERY" rather than "COMMIT" places the production wait in a statement BEFORE
// the refused one: the statement in flight returned late, and the NEXT query was
// refused because Prisma's timer had already expired the transaction (Prisma
// 7.9 does not cancel the statement in flight — it rolls back after it). So
// both cells force a wait inside the statement that PRECEDES a
// `resolveWorkspaceAccess` read, behind a lock another session holds: the
// cookie-pin branch (the production frame) behind a table lock on
// `workspace_membership`, and the last-active branch behind one on `project`.
// Each lock is released only once Postgres itself reports the resolver's backend
// waiting on it, so it is not a sleep race.
//
// This resolver is the same kind of door as the 2FA gate (MOTIR-5866) and the
// active-project resolver (MOTIR-6254): `getWorkspaceContext` runs it for every
// signed-in page, action and route, so the wrong answer after a stall is a 500
// on whichever request was unlucky.

/** Past Prisma's 5000 ms default, and inside the budget the fix declares. */
const WAIT_MS = 5_500;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeMemberWithWorkspace() {
  const owner = await usersService.createUser({
    email: 'active-workspace-budget@example.com',
    password: 'hunter2hunter2',
    name: 'Ada',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  return { owner, workspace };
}

/** The query text of the first backend in THIS test database that is blocked on
 *  a lock — a signal read from the server, never a guess about timing. */
async function waitForABackendBlockedOnALock(): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await adminDb.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (rows[0]) return rows[0].query;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the resolver never blocked on the lock — the wait was not forced');
}

/**
 * Hold `lock` in its own transaction, start the resolver, wait until the
 * resolver is BLOCKED on it, keep it blocked past the 5 s default, release, and
 * hand back how the resolver settled plus the statement that was waiting.
 */
async function resolveBehindALock(
  userId: string,
  cookieWorkspaceId: string | null,
  lock: (tx: Parameters<Parameters<typeof adminDb.$transaction>[0]>[0]) => Promise<unknown>,
) {
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
  let lockHeld!: () => void;
  const lockTaken = new Promise<void>((resolve) => (lockHeld = resolve));
  const holder = adminDb.$transaction(
    async (tx) => {
      await lock(tx);
      lockHeld();
      await lockReleased;
    },
    { timeout: 60_000 },
  );
  await lockTaken;

  const settled = workspacesService.resolveActiveWorkspace(userId, cookieWorkspaceId, 'Ada').then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const blockedQuery = await waitForABackendBlockedOnALock();
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  releaseLock();
  await holder;

  return { blockedQuery, result: await settled };
}

describe('the active-workspace resolver WAITS past 5 s and still answers (MOTIR-6253)', () => {
  it('answers when the wait lands in the cookie-pinned membership read — the production frame', async () => {
    const { owner, workspace } = await makeMemberWithWorkspace();

    const { blockedQuery, result } = await resolveBehindALock(owner.id, workspace.id, (tx) =>
      tx.$executeRawUnsafe('LOCK TABLE workspace_membership IN ACCESS EXCLUSIVE MODE'),
    );
    // It is the resolver's own first read that waits — the pinned membership
    // with its workspace — so the refused statement is the NEXT one, the access
    // gate's `workspace` read: the production message and frame.
    expect(blockedQuery).toMatch(/"public"\."workspace_membership"/);

    // THE DEFECT: before the fix this rejects with P2028 — "A query cannot be
    // executed on an expired transaction" — the production message verbatim.
    if (!result.ok) throw result.error;
    expect(result.value).toBe(workspace.id);
  }, 60_000);

  it('answers when the wait lands in the last-active project read — no cookie pin', async () => {
    const { owner, workspace } = await makeMemberWithWorkspace();
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Apollo',
    });
    await adminDb.user.update({
      where: { id: owner.id },
      data: { lastActiveProjectId: project.id },
    });

    const { blockedQuery, result } = await resolveBehindALock(owner.id, null, (tx) =>
      tx.$executeRawUnsafe('LOCK TABLE project IN ACCESS EXCLUSIVE MODE'),
    );
    expect(blockedQuery).toMatch(/"public"\."project"/);

    if (!result.ok) throw result.error;
    // The last-active pointer won, not the first-by-createdAt default — the
    // wait did not silently degrade the landing either.
    expect(result.value).toBe(workspace.id);
  }, 60_000);

  it('declares a ceiling above the wait production actually observed', () => {
    // The only production evidence is one event that waited 30 459 ms before its
    // next statement. A ceiling at or under that — the 30 s the two sibling
    // doors use — would have failed this exact event anyway.
    expect(ACTIVE_WORKSPACE_RESOLVE_TX.timeoutMs).toBeGreaterThan(30_459);
    // `maxWaitMs` stays Prisma's default: this is a transaction that STARTED
    // and then waited, not one waiting for a connection.
    expect(ACTIVE_WORKSPACE_RESOLVE_TX.maxWaitMs).toBe(2_000);
  });
});

// MOTIR-8288 — THE FRONT DOOR DIED BECAUSE ITS TRANSACTION COULD NOT START.
//
// Production, 2026-10-12T07:52:15Z, `GET /workbench`: P2028 *Unable to start a
// transaction in the given time* out of `resolveActiveWorkspace`, with the event
// loop blocked ~12.9 s (`not_in_js`) under 42 s of CPU steal and the pool idle.
// The 2 s `maxWait` expired while the process could not run at all — the
// transaction never began — and the `(authed)` boundary turned it into React's
// redacted server-error view (digest 3728043220).
//
// DRIVEN, NOT WAITED FOR: the event loop is blocked SYNCHRONOUSLY for longer
// than `maxWaitMs` at the moment the pool hands the transaction its connection
// (pg-pool emits `acquire` synchronously, after Prisma has armed its `maxWait`
// timer and before `BEGIN` can be answered). When the loop runs again the timer
// is the first thing due, so Prisma rejects with the production message — the
// same mechanism as production, minus the host.

/** Past `ACTIVE_WORKSPACE_RESOLVE_TX.maxWaitMs`, so the start always expires. */
const BLOCK_MS = ACTIVE_WORKSPACE_RESOLVE_TX.maxWaitMs + 500;

function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // a synchronous stall — nothing else on this process can run
  }
}

/**
 * Count every connection the pool hands out from now on, blocking the event
 * loop on the acquisitions numbered in `stallOn` (1-based). Each acquisition is
 * one transaction start, so the count IS the number of transactions attempted.
 */
function stallTransactionStarts(stallOn: readonly number[]) {
  const pool = dbPool();
  if (!pool) throw new Error('the test client has no pool to observe');
  let acquired = 0;
  const onAcquire = (_client: PoolClient) => {
    acquired += 1;
    if (stallOn.includes(acquired)) blockEventLoop(BLOCK_MS);
  };
  pool.on('acquire', onAcquire);
  return {
    count: () => acquired,
    stop: () => pool.off('acquire', onAcquire),
  };
}

let stall: ReturnType<typeof stallTransactionStarts> | null = null;
afterEach(() => {
  stall?.stop();
  stall = null;
});

async function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('the front-door resolution survives a transaction that could not START (MOTIR-8288)', () => {
  it('resolves after ONE fresh transaction when the first start expires on maxWait', async () => {
    const { owner, workspace } = await makeMemberWithWorkspace();

    stall = stallTransactionStarts([1]);
    const result = await settle(
      workspacesService.resolveActiveWorkspace(owner.id, workspace.id, 'Ada'),
    );

    // THE DEFECT: before the fix this rejects with the production P2028.
    if (!result.ok) throw result.error;
    expect(result.value).toBe(workspace.id);
    // The failed start, then exactly one fresh transaction.
    expect(stall.count()).toBe(2);
  }, 30_000);

  it('lets a SECOND consecutive maxWait propagate unchanged — no third attempt', async () => {
    const { owner, workspace } = await makeMemberWithWorkspace();

    stall = stallTransactionStarts([1, 2]);
    const result = await settle(
      workspacesService.resolveActiveWorkspace(owner.id, workspace.id, 'Ada'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(transactionTimeoutHalf(result.error)).toBe('maxWait');
    expect((result.error as Error).message).toMatch(
      /Unable to start a transaction in the given time/,
    );
    expect(stall.count()).toBe(2);
  }, 30_000);

  it('does NOT retry ensureDefaultWorkspace — its own write transaction propagates its maxWait', async () => {
    // No workspace yet: the read-only resolution answers null, so the resolver
    // falls through to the self-heal, whose transaction is the SECOND start.
    const user = await usersService.createUser({
      email: 'active-workspace-selfheal@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });

    stall = stallTransactionStarts([2]);
    const result = await settle(workspacesService.resolveActiveWorkspace(user.id, null, 'Ada'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(transactionTimeoutHalf(result.error)).toBe('maxWait');
    // The resolution's one transaction, then the self-heal's — not retried.
    expect(stall.count()).toBe(2);
    // The write never started, so nothing was self-healed behind the error.
    expect(await adminDb.workspaceMembership.count({ where: { userId: user.id } })).toBe(0);
  }, 30_000);
});

describe('retryOnceOnTransactionStartTimeout retries the maxWait half ONLY (MOTIR-8288)', () => {
  function p2028(message: string) {
    return new Prisma.PrismaClientKnownRequestError(`Transaction API error: ${message}`, {
      code: 'P2028',
      clientVersion: 'test',
    });
  }

  async function attempts(errors: readonly unknown[]) {
    let calls = 0;
    const result = await settle(
      retryOnceOnTransactionStartTimeout(async () => {
        const err = errors[calls];
        calls += 1;
        if (err) throw err;
        return 'answered';
      }),
    );
    return { calls, result };
  }

  it('retries a maxWait P2028 once and answers', async () => {
    const { calls, result } = await attempts([
      p2028('Unable to start a transaction in the given time.'),
    ]);
    expect(result).toEqual({ ok: true, value: 'answered' });
    expect(calls).toBe(2);
  });

  it('does not retry the timeout half — a transaction that STARTED and expired', async () => {
    const expired = p2028(
      'A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 9997 ms passed since the start of the transaction.',
    );
    expect(transactionTimeoutHalf(expired)).toBe('timeout');
    const { calls, result } = await attempts([expired]);
    expect(result).toEqual({ ok: false, error: expired });
    expect(calls).toBe(1);
  });

  it('does not retry any non-P2028 error', async () => {
    const unique = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const plain = new Error('boom');
    for (const err of [unique, plain]) {
      const { calls, result } = await attempts([err]);
      expect(result).toEqual({ ok: false, error: err });
      expect(calls).toBe(1);
    }
  });
});
