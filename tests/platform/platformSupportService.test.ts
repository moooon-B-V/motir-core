import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  PlatformSuspensionStateError,
  PlatformUserNotFoundError,
} from '@/lib/platform/errors';
import {
  PLATFORM_USER_SEARCH_MIN_LENGTH,
  platformSupportService,
} from '@/lib/services/platformSupportService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The day-1 SUPPORT tools (MOTIR-1167 · design
 * `platform-admin/design-notes.md` Panel 9 · ADR §7's `operator` tier).
 *
 * Three properties carry the weight here, and each is tested from the side that
 * can actually fail:
 *
 * 1. **A reason is REQUIRED for every write**, and the enforcement is in the
 *    transaction rather than in the dialog — so it is asserted by calling the
 *    service directly with a blank one, which is what a Server Action invoked
 *    without the dialog does.
 * 2. **A refused write leaves NO audit row.** The ADR's §3a property is
 *    *"a read that rolls back leaves no audit row"*, and the way to break it is
 *    to return a sentinel and throw outside the transaction. Every refusal below
 *    is checked against the row count, not just against the thrown type.
 * 3. **Suspending REVOKES the open sessions.** The column stops the next
 *    sign-in; the revocation stops the ones already open, and a suspension that
 *    did only the first would leave a signed-in account working for the whole
 *    session lifetime.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The one `vi.mock` `CLAUDE.md` allows, at the platform tier's equivalent of
    // `getSession` — the test environment has no cookies. Everything under it is
    // the real path against real Postgres; `platformStaffGate.test.ts` tests the
    // gate itself.
    requirePlatformStaff: vi.fn(async () => currentPrincipal),
  };
});

// The password-reset send is an EXTERNAL side effect, so it is stubbed at the
// framework boundary rather than at the service — what is under test is that the
// service triggers the SHIPPED flow with the account's OWN address, never that
// Better-Auth can send mail.
const requestPasswordReset = vi.hoisted(() => vi.fn(async () => ({ status: true })));
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, auth: { ...actual.auth, api: { requestPasswordReset } } };
});
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

let currentPrincipal: PlatformPrincipal;

async function seedOperator(role: 'support' | 'operator' = 'operator') {
  const user = await createTestUser({ email: `ops+${role}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  requestPasswordReset.mockClear();
  currentPrincipal = await seedOperator();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the lookup', () => {
  it('finds an account by a fragment of its email address, case-insensitively', async () => {
    await createTestUser({ email: 'Ada.Lovelace@example.com', name: 'Ada Lovelace' });
    await createTestUser({ email: 'grace@example.com', name: 'Grace Hopper' });

    const results = await platformSupportService.searchUsers(currentPrincipal, 'ADA.LOVE');
    expect(results.map((r) => r.email)).toEqual(['ada.lovelace@example.com']);
  });

  it('finds an account by name — people write in from a different address', async () => {
    await createTestUser({ email: 'gh@example.com', name: 'Grace Hopper' });
    const results = await platformSupportService.searchUsers(currentPrincipal, 'hopper');
    expect(results.map((r) => r.name)).toEqual(['Grace Hopper']);
  });

  it('refuses a query under the floor by answering EMPTY, and audits nothing', async () => {
    await createTestUser({ email: 'ada@example.com', name: 'Ada Lovelace' });

    const short = 'a'.repeat(PLATFORM_USER_SEARCH_MIN_LENGTH - 1);
    expect(await platformSupportService.searchUsers(currentPrincipal, short)).toEqual([]);
    // ⚠️ AND NO AUDIT ROW. A query the service declined to run is not a read of
    // the estate, and recording one would put noise in the trail for something
    // that never touched a row.
    expect(await auditRows()).toHaveLength(0);
  });

  it('carries the suspension state on each row, so the list says which are closed', async () => {
    const user = await createTestUser({ email: 'ada@example.com', name: 'Ada Lovelace' });
    await adminDb.user.update({
      where: { id: user.id },
      data: { suspendedAt: new Date('2026-08-01T00:00:00.000Z'), suspendedReason: 'fraud' },
    });

    const [row] = await platformSupportService.searchUsers(currentPrincipal, 'ada@');
    expect(row!.suspendedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('records the search as an estate read, with the query as the target label', async () => {
    await platformSupportService.searchUsers(currentPrincipal, 'ada@example.com');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('estate.read');
    expect(rows[0]!.targetLabel).toBe('ada@example.com');
  });
});

describe('the drill-down', () => {
  it('returns the account, its session count, and an empty action log', async () => {
    const user = await createTestUser({ email: 'ada@example.com', name: 'Ada Lovelace' });

    const page = await platformSupportService.getUserPage(currentPrincipal, user.id);
    expect(page.user.email).toBe('ada@example.com');
    expect(page.user.activeSessionCount).toBe(0);
    expect(page.actions).toEqual([]);
  });

  it('counts the account’s open sessions', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await adminDb.session.createMany({
      data: [
        { userId: user.id, token: 'tok_1', expiresAt: new Date(Date.now() + 86_400_000) },
        { userId: user.id, token: 'tok_2', expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    const page = await platformSupportService.getUserPage(currentPrincipal, user.id);
    expect(page.user.activeSessionCount).toBe(2);
  });

  it('throws for an unknown id AND leaves no audit row', async () => {
    // ⚠️ THE SECOND HALF IS THE ONE THAT CAN REGRESS. The audit row is INSERTed
    // as the first statement of the platform transaction, so a service that
    // returned a sentinel and threw outside it would COMMIT a row recording a
    // read of an account that does not exist. Throwing from inside rolls the row
    // back with the read — the ADR's §3a property, from the failure side.
    await expect(
      platformSupportService.getUserPage(currentPrincipal, 'user_does_not_exist'),
    ).rejects.toBeInstanceOf(PlatformUserNotFoundError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('shows only operator WRITES in the log — a page view is not one', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    // Three reads of the account and one write. The log draws the write.
    await platformSupportService.getUserPage(currentPrincipal, user.id);
    await platformSupportService.getUserPage(currentPrincipal, user.id);
    await platformSupportService.setSuspended(currentPrincipal, user.id, true, 'abuse report #4');

    const page = await platformSupportService.getUserPage(currentPrincipal, user.id);
    expect(page.actions.map((a) => a.action)).toEqual(['user.suspend']);
    expect(page.actions[0]!.reason).toBe('abuse report #4');
    // The reads ARE all in the table — they are just not what this card shows.
    // Three page views above, and exactly one row per view: `getUserPage` is one
    // platform transaction for BOTH halves of the page, which is what keeps the
    // trail's own noise floor below the actions it exists to record.
    expect((await auditRows()).filter((r) => r.action === 'user.read')).toHaveLength(3);
  });
});

describe('send password reset', () => {
  it('triggers the shipped flow against the ACCOUNT’s own address', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });

    await platformSupportService.sendPasswordReset(currentPrincipal, user.id, 'locked out');

    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
    const body = (
      requestPasswordReset.mock.calls as unknown as [{ body: { email: string } }][]
    )[0]![0];
    // ⚠️ The account holder's address, never the operator's. This is what makes
    // the action safe to give an `operator` rather than a `superadmin`: the mail
    // lands in the customer's inbox, so a compromised operator session cannot
    // take an account over with it.
    expect(body.body.email).toBe('ada@example.com');
    expect(body.body.email).not.toBe(currentPrincipal.email);
  });

  it('writes ONE audit row carrying the operator’s reason', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await platformSupportService.sendPasswordReset(currentPrincipal, user.id, 'locked out');

    const rows = (await auditRows()).filter((r) => r.action === 'user.password_reset_sent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('locked out');
    expect(rows[0]!.targetId).toBe(user.id);
    expect(rows[0]!.actorRole).toBe('operator');
  });

  it('refuses a BLANK reason, sends nothing, and writes nothing', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });

    await expect(
      // Whitespace, not an empty string: a space would defeat the dialog's
      // required field while looking like compliance in the log.
      platformSupportService.sendPasswordReset(currentPrincipal, user.id, '   '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('changes nothing about the account — no password, no sessions', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await adminDb.session.create({
      data: { userId: user.id, token: 'tok_1', expiresAt: new Date(Date.now() + 86_400_000) },
    });

    await platformSupportService.sendPasswordReset(currentPrincipal, user.id, 'locked out');

    const after = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.suspendedAt).toBeNull();
    expect(await adminDb.session.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe('suspend and unsuspend', () => {
  it('stamps the column, records the reason, and REVOKES every open session', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await adminDb.session.createMany({
      data: [
        { userId: user.id, token: 'tok_1', expiresAt: new Date(Date.now() + 86_400_000) },
        { userId: user.id, token: 'tok_2', expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    const at = new Date('2026-08-26T10:00:00.000Z');
    const result = await platformSupportService.setSuspended(
      currentPrincipal,
      user.id,
      true,
      'abuse report #4',
      at,
    );

    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.suspendedAt?.toISOString()).toBe(at.toISOString());
    expect(row.suspendedReason).toBe('abuse report #4');
    // ⚠️ THE HALF THAT TAKES EFFECT NOW. The column stops the NEXT sign-in; this
    // stops the ones already open, which is the window the action exists to
    // close and the thing the confirm dialog promises in as many words.
    expect(await adminDb.session.count({ where: { userId: user.id } })).toBe(0);
    expect(result.activeSessionCount).toBe(0);
  });

  it('clears both columns on unsuspend and revokes nothing further', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await platformSupportService.setSuspended(currentPrincipal, user.id, true, 'abuse');
    await platformSupportService.setSuspended(currentPrincipal, user.id, false, 'appeal upheld');

    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.suspendedAt).toBeNull();
    // The live reason is CLEARED — the account's own state must not keep
    // asserting a reason for a suspension that has been lifted. The audit log
    // keeps every reason ever given.
    expect(row.suspendedReason).toBeNull();

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['user.suspend', 'user.unsuspend']);
    expect(rows[1]!.reason).toBe('appeal upheld');
  });

  it('requires a reason to UNSUSPEND too', async () => {
    // The half somebody would be tempted to leave blank: the trail has to answer
    // "why is this account open again?" as readably as why it was closed.
    const user = await createTestUser({ email: 'ada@example.com' });
    await platformSupportService.setSuspended(currentPrincipal, user.id, true, 'abuse');

    await expect(
      platformSupportService.setSuspended(currentPrincipal, user.id, false, ''),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.suspendedAt).not.toBeNull();
  });

  it('refuses a second suspend, and the refusal leaves NO audit row', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await platformSupportService.setSuspended(currentPrincipal, user.id, true, 'abuse');

    await expect(
      platformSupportService.setSuspended(currentPrincipal, user.id, true, 'abuse again'),
    ).rejects.toBeInstanceOf(PlatformSuspensionStateError);

    // ⚠️ ONE row, not two. A row recording a suspension that was REFUSED is
    // worse than no row: it is the trail asserting something about the account
    // that the account itself contradicts.
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['user.suspend']);
    expect(rows[0]!.reason).toBe('abuse');
  });

  it('refuses an unsuspend on an account that is not suspended', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await expect(
      platformSupportService.setSuspended(currentPrincipal, user.id, false, 'nothing to lift'),
    ).rejects.toBeInstanceOf(PlatformSuspensionStateError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('CONCURRENT suspends of one account produce exactly one suspension', async () => {
    // ⚠️ THE LOCK, EXERCISED. This is a read-derived write: whether to write at
    // all depends on the state read a moment earlier. Without `FOR UPDATE` both
    // callers read "open", both write, and the log carries two suspensions of one
    // account while the column silently keeps whichever reason committed last —
    // a trail that disagrees with the account it describes. A real-concurrency
    // test rather than a mocked one, per `CLAUDE.md`'s locking rule: a
    // count-then-write guard with no lock only fails under a warm pool.
    const user = await createTestUser({ email: 'ada@example.com' });

    const settled = await Promise.allSettled([
      platformSupportService.setSuspended(currentPrincipal, user.id, true, 'operator A'),
      platformSupportService.setSuspended(currentPrincipal, user.id, true, 'operator B'),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const rows = (await auditRows()).filter((r) => r.action === 'user.suspend');
    expect(rows).toHaveLength(1);
    // And the account's own reason is the one the surviving row records — the
    // two cannot disagree.
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.suspendedReason).toBe(rows[0]!.reason);
  });

  it('throws for an unknown id AND leaves no audit row', async () => {
    await expect(
      platformSupportService.setSuspended(currentPrincipal, 'user_nope', true, 'because'),
    ).rejects.toBeInstanceOf(PlatformUserNotFoundError);
    expect(await auditRows()).toHaveLength(0);
  });
});
