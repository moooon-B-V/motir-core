import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
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
