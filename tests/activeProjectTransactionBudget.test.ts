import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-6254 — THE ACTIVE-PROJECT RESOLVER DIED ON PRISMA'S 5 s BUDGET WHILE
// DOING NO WORK.
//
// Observed in production once, 2026-09-24, on `GET /api/workbench/stream` as a
// `P2028` — *A commit cannot be executed on an expired transaction. The timeout
// for this transaction was 5000 ms, however 6455 ms passed* — at
// `projectsService.getActiveProject`. That transaction is two indexed reads (the
// membership, the pinned project) and, only when the pointer has to heal, one
// single-row UPDATE. It cannot take 6 s by working; it can only take 6 s by
// WAITING.
//
// "COMMIT" rather than "QUERY" places the production wait INSIDE a statement:
// every query returned, the last one late, and the commit was then refused. So
// both cells force a wait inside a statement, behind a lock another session
// holds — the hot path (pointer set) behind a migration-shaped table lock on
// `project`, and the heal path (pointer unset) behind the row lock a
// concurrent writer holds on the member's own membership row, which is what two
// requests healing the same pointer at once look like. Each lock is released
// only once Postgres itself reports the resolver's backend waiting on it, so it
// is not a sleep race.
//
// This resolver is the same kind of door the 2FA gate is (MOTIR-5866): the
// (authed) layout and ~130 other pages, actions and routes pass through it, so
// the wrong answer after a stall is a 500 on whichever request was unlucky.

/** Past Prisma's 5000 ms default, and inside the budget the fix declares. */
const WAIT_MS = 5_500;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeMemberWithProject() {
  const owner = await usersService.createUser({
    email: 'active-project-budget@example.com',
    password: 'hunter2hunter2',
    name: 'Ada',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Apollo',
  });
  return { owner, workspace, project };
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
  workspaceId: string,
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

  const settled = projectsService.getActiveProject(userId, workspaceId).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const blockedQuery = await waitForABackendBlockedOnALock();
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  releaseLock();
  await holder;

  return { blockedQuery, result: await settled };
}

describe('the active-project resolver WAITS past 5 s and still answers (MOTIR-6254)', () => {
  it('answers when the wait lands inside the pinned-project read — the hot path', async () => {
    const { owner, workspace, project } = await makeMemberWithProject();
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });

    const { blockedQuery, result } = await resolveBehindALock(owner.id, workspace.id, (tx) =>
      tx.$executeRawUnsafe('LOCK TABLE project IN ACCESS EXCLUSIVE MODE'),
    );
    // It is one of the resolver's own reads that is waiting. Measured, the first
    // to block is the membership read's `workspace` include rather than the
    // pinned-project read — a policy evaluation reaches `project` first — and
    // either one leaves the transaction waiting inside a statement.
    expect(blockedQuery).toMatch(/FROM "public"\."(workspace|project)"/);

    // THE DEFECT: before the fix this rejects with P2028 — "A commit cannot be
    // executed on an expired transaction" — the production message verbatim.
    if (!result.ok) throw result.error;
    expect(result.value?.id).toBe(project.id);
  }, 60_000);

  it('answers when the wait lands inside the pointer heal, behind a concurrent writer of the same membership row', async () => {
    const { owner, workspace, project } = await makeMemberWithProject();
    // An UNSET pointer: the resolver recovers to the first non-archived project
    // and writes it back — the one statement in this transaction that takes a lock.
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { activeProjectId: null },
    });

    const { blockedQuery, result } = await resolveBehindALock(
      owner.id,
      workspace.id,
      (tx) =>
        tx.$queryRaw`SELECT id FROM workspace_membership
        WHERE "userId" = ${owner.id} AND "workspaceId" = ${workspace.id} FOR UPDATE`,
    );
    expect(blockedQuery).toMatch(/UPDATE "public"\."workspace_membership"/);

    if (!result.ok) throw result.error;
    expect(result.value?.id).toBe(project.id);
    const membership = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    });
    // The heal COMMITTED — the pointer is written, not rolled back with the 500.
    expect(membership.activeProjectId).toBe(project.id);
  }, 60_000);
});
