import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { InvalidEmailChangeTokenError } from '@/lib/users/errors';
import { truncateAuthTables } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// Story 8.8 · Subtask 8.8.25 — STORY-LEVEL integration coverage for the profile
// feature, BEYOND each subtask's own units. Real Postgres, no mocks.
//
// The per-subtask suites already prove each method in ISOLATION against real
// Postgres — `profile-service.test.ts` (name/avatar + DTO read-back),
// `email-change.test.ts` (request enqueue + confirm/swap/re-key, token
// single-use + EXPIRY, the same-address REQUEST uniqueness race),
// `users-service-password.test.ts` (every password branch: wrong-current /
// weak / OAuth-only / session-revoke). This suite does NOT re-assert those; it
// adds what units STRUCTURALLY can't — the CROSS-SUBTASK assembly:
//
//   • the three mutations (8.8.21 profile · 8.8.22 email · 8.8.23 password)
//     walked end-to-end and read BACK through the consumer reader
//     (`getProfile` / `getPasswordCapability` / `verifyPassword`), proving state
//     stays COHERENT ACROSS features — the profile (name + avatar) survives an
//     email swap, and the password path works on the very credential the
//     email-change RE-KEYED (8.8.22's `accountId` swap ↔ 8.8.23's lock-by-userId);
//   • the CONFIRM-path single-use guarantee under genuine warm-pool concurrency
//     (the request-path race is the unit suite's; this is the consume-before-
//     validate race on a single token).
//
// This is the writer→consumer-DTO seam at story scale (catches key drift the
// per-method unit returns mask) + the warm-pool TOCTOU on the confirm path.

const PASSWORD = 'lifecycle-pass-1';
const NEW_PASSWORD = 'lifecycle-pass-2';
// Our public blob host — the own-avatar gate accepts `/avatars/<userId>/…` here
// (the URL `profile-service.test.ts` proves passes `updateProfile`'s gate). A
// FIRST set (no prior avatar) triggers no blob GC, so no blob adapter is needed.
const BLOB_HOST = 'teststore.public.blob.vercel-storage.com';
const ownAvatar = (userId: string, name: string) =>
  `https://${BLOB_HOST}/avatars/${userId}/${name}`;

let emailEvents: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  emailEvents = captureEmailEvents();
});
afterEach(() => emailEvents.restore());
afterAll(async () => {
  await db.$disconnect();
});

/**
 * Warm the connection pool so concurrent service calls land on DISTINCT live
 * connections — a lock/consume-then-write guard only RACES (and is thus only
 * PROVEN) under real parallelism (the warm-pool TOCTOU precedent; a cold pool
 * serializes on one connection and hides the race).
 */
async function warmPool(n = 6): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
}

describe('profile feature — story-level integration (8.8.25)', () => {
  it('walks the full profile lifecycle; every mutation reads BACK through the consumer DTO, coherent across features', async () => {
    const user = await usersService.createUser({
      email: 'old@example.com',
      password: PASSWORD,
      name: 'Ada',
    });

    // (1) PROFILE (8.8.21): set name + avatar → read back through getProfile's
    // UserProfileDto. The DTO read-back is the seam that catches key drift the
    // method's own return masks.
    const avatar = ownAvatar(user.id, 'me.png');
    await usersService.updateProfile(user.id, { name: 'Ada Lovelace', image: avatar });
    let profile = await usersService.getProfile(user.id);
    expect(profile).toEqual({
      id: user.id,
      name: 'Ada Lovelace',
      email: 'old@example.com',
      image: avatar,
    });

    // (2) EMAIL (8.8.22): request → the confirm email is enqueued AFTER commit
    // (observed via the inngest spy), then confirm swaps the live address.
    const { token } = await usersService.requestEmailChange(user.id, 'new@example.com');
    expect(emailEvents.events.map((e) => e.data.template)).toEqual(['email-change']);
    expect(emailEvents.events[0]!.data.to).toBe('new@example.com');
    const confirmed = await usersService.confirmEmailChange(token);
    expect(confirmed).toEqual({ userId: user.id, newEmail: 'new@example.com' });

    // CROSS-FEATURE COHERENCE: the email swap must NOT disturb the profile
    // (name + avatar) — read it back through the SAME consumer DTO.
    profile = await usersService.getProfile(user.id);
    expect(profile).toEqual({
      id: user.id,
      name: 'Ada Lovelace',
      email: 'new@example.com',
      image: avatar,
    });

    // (3) PASSWORD (8.8.23) on the RE-KEYED credential: email-change re-keyed the
    // credential account's `accountId` to new@; a subsequent password change must
    // still lock+update that same credential (by userId) and verify under the NEW
    // address — the 8.8.22 ↔ 8.8.23 seam no single unit exercises.
    await usersService.changePassword({
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect((await usersService.getPasswordCapability(user.id)).hasPassword).toBe(true);
    expect(await usersService.verifyPassword('new@example.com', NEW_PASSWORD)).toBe(true);
    // The old password no longer works, and the freed old address verifies nothing.
    expect(await usersService.verifyPassword('new@example.com', PASSWORD)).toBe(false);
    expect(await usersService.verifyPassword('old@example.com', NEW_PASSWORD)).toBe(false);
  });

  it('two concurrent confirms of the SAME token stay coherent under a warm pool (no corruption, no raw error escapes)', async () => {
    const user = await usersService.createUser({
      email: 'old@example.com',
      password: PASSWORD,
      name: 'Grace',
    });
    const { token } = await usersService.requestEmailChange(user.id, 'new@example.com');

    // Race two confirms of the SAME token on distinct live connections (warm
    // pool, else a cold pool serializes on one connection and hides the race).
    // The confirm consumes the token + locks the user row inside its tx, and the
    // swap is IDEMPOTENT (both set email→new@). So the implementation admits TWO
    // legitimate outcomes — both fulfilled (each applied the same swap) OR one
    // fulfilled + one `InvalidEmailChangeTokenError` (the loser found the token
    // already consumed). A concurrency test must accept EVERY legitimate outcome,
    // never a fixed winner-count (CLAUDE.md). The story-level guarantee is the
    // COHERENT END STATE, not the split.
    await warmPool();
    const settled = await Promise.allSettled([
      usersService.confirmEmailChange(token),
      usersService.confirmEmailChange(token),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    // At least one confirm applied the swap...
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // ...and EVERY rejection is the typed single-use error — never a raw DB error
    // (P2002 / lock) escaping the service (CLAUDE.md: races become typed errors).
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InvalidEmailChangeTokenError);
    }

    // Coherent end state regardless of the split: the live address is the new
    // one (swapped exactly once, not to a wrong value), the credential is re-keyed
    // to it, the token is consumed, and no pending row lingers.
    expect((await usersService.getProfile(user.id))?.email).toBe('new@example.com');
    const credential = await db.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    });
    expect(credential!.accountId).toBe('new@example.com');
    expect(await db.emailChangeRequest.findMany({ where: { userId: user.id } })).toHaveLength(0);
    // Single-use holds going forward: a fresh confirm of the spent token is rejected.
    await expect(usersService.confirmEmailChange(token)).rejects.toBeInstanceOf(
      InvalidEmailChangeTokenError,
    );
  });

  it('an OAuth-only user: profile updates + reads back, but the password capability stays false', async () => {
    // The assembled OAuth-user view across 8.8.21 (profile) + 8.8.23 (password
    // capability): an OAuth-only account has no credential, so getPasswordCapability
    // is false, yet name updates round-trip through the consumer DTO exactly as a
    // credential user's do.
    const user = await usersService.findOrCreateOAuthUser({
      provider: 'google',
      providerAccountId: 'google-lifecycle-1',
      email: 'oauth@example.com',
      name: 'Oauth User',
    });

    await usersService.updateProfile(user.id, { name: 'Renamed Oauth' });
    const profile = await usersService.getProfile(user.id);
    expect(profile?.name).toBe('Renamed Oauth');
    expect(profile?.email).toBe('oauth@example.com');
    expect((await usersService.getPasswordCapability(user.id)).hasPassword).toBe(false);
  });
});
