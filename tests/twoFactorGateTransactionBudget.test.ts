import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { twoFactorPolicyRepository } from '@/lib/repositories/twoFactorPolicyRepository';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-5866 — THE 2FA GATE DIED ON PRISMA'S 5 s BUDGET WHILE DOING NO WORK.
//
// Observed in production once, 2026-09-20, on `GET /api/notifications/unread-count`
// as a `P2028` — *A query cannot be executed on an expired transaction. The
// timeout for this transaction was 5000 ms, however 17684 ms passed* — at
// `twoFactorPolicyRepository.findRequirement`, reached through
// `requireCompliantWorkspaceContext`. That transaction is `withUserContext`: one
// `set_config` and ONE read, no row lock, no network call. It cannot take 17 s by
// working; it can only take 17 s by WAITING.
//
// ⚠️ AND THE 5 s BUDGET NEVER SHORTENED THAT WAIT. Prisma's timer does not cancel
// the statement in flight: it queues its rollback behind it, so the request
// waited the full 17.7 s AND then answered 500. For a read that holds no lock the
// expiry buys nothing — it only discards the answer the wait had already paid for.
//
// "QUERY" rather than "COMMIT" places the production wait BEFORE the policy read
// was issued — while `set_config` was in flight, or while the process or the
// database was stalled — so the first cell forces exactly that phase. The second
// forces the other place a wait can land, INSIDE the read, behind the lock a
// migration's `ALTER TABLE` takes; it is released only once Postgres itself
// reports the read's backend waiting on it, so it is not a sleep race.

/** Past Prisma's 5000 ms default, and inside the budget the fix declares. */
const WAIT_MS = 5_500;

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A person whose ORGANIZATION requires 2FA and who has not enrolled — the one
 *  verdict the gate exists to deliver, so a 500 here is a held person let
 *  through to an error page rather than to the enrolment screen. */
async function makeHeldPerson() {
  const owner = await usersService.createUser({
    email: 'gate-budget@example.com',
    password: 'hunter2hunter2',
    name: 'Ada',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { requiresTwoFactor: true },
  });
  return { owner, organizationId: workspace.organizationId };
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
  throw new Error('the policy read never blocked on the lock — the wait was not forced');
}

describe('the 2FA gate WAITS past 5 s and still answers (MOTIR-5866)', () => {
  it('answers when the wait lands BEFORE the policy read is issued — the production phase', async () => {
    const { owner, organizationId } = await makeHeldPerson();

    // The transaction has started and bound `app.user_id`; the read is issued
    // only after the wait, exactly as a stalled `set_config` would leave it.
    const findRequirement =
      twoFactorPolicyRepository.findRequirement.bind(twoFactorPolicyRepository);
    vi.spyOn(twoFactorPolicyRepository, 'findRequirement').mockImplementation(async (id, tx) => {
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      return findRequirement(id, tx);
    });

    // THE DEFECT: before the fix this rejects with P2028 — "A query cannot be
    // executed on an expired transaction" — the production message verbatim.
    const dto = await twoFactorPolicyService.resolveRequirement(owner.id);
    expect(dto.required).toBe(true);
    expect(dto.compliant).toBe(false);
    expect(dto.mandatedBy).toEqual({ tier: 'organization', id: organizationId, name: 'Acme' });
  }, 30_000);

  it('answers when the wait lands INSIDE the policy read, behind a migration-shaped lock', async () => {
    const { owner, organizationId } = await makeHeldPerson();

    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockHeld!: () => void;
    const lockTaken = new Promise<void>((resolve) => (lockHeld = resolve));
    const holder = adminDb.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE organization_membership IN ACCESS EXCLUSIVE MODE');
        lockHeld();
        await lockReleased;
      },
      { timeout: 60_000 },
    );
    await lockTaken;

    const settled = twoFactorPolicyService.resolveRequirement(owner.id).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const blockedQuery = await waitForABackendBlockedOnALock();
    // It is the policy read that is waiting, not some other statement.
    expect(blockedQuery).toContain('mandating_org');

    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    releaseLock();
    await holder;

    const result = await settled;
    // Before the fix: P2028, "A commit cannot be executed on an expired transaction".
    if (!result.ok) throw result.error;
    expect(result.value.required).toBe(true);
    expect(result.value.mandatedBy).toEqual({
      tier: 'organization',
      id: organizationId,
      name: 'Acme',
    });
  }, 60_000);
});
