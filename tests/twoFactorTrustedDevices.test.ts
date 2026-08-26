import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { TRUST_DEVICE_PREFIX } from '@/lib/repositories/verificationRepository';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Story 8.11 · Subtask MOTIR-1221 — the trusted-device half.
//
// "Remember this device" is Better-Auth's (a `trustDevice` flag on the verify
// call). REVOKING one is Motir's, because the plugin ships no revoke — and the
// story's acceptance criterion is the pair: the suppression works, and clearing
// it restores the challenge.
//
// Two things here are worth a real database rather than a mock:
//
//   1. THE OWNERSHIP SCOPE. The revoke takes an `id` off a request body, and
//      `verification` holds every token this product mints — password resets,
//      email-change confirmations, and other people's device grants. If the
//      `where` were keyed on `id` alone, any signed-in user could delete any row
//      in that table. That is asserted directly, with a second user's grant.
//   2. THE PREFIX IS THE PLUGIN'S LITERAL. `trust-device-` is written by
//      `verify-two-factor.mjs`, not by us, so a Better-Auth upgrade that renamed
//      it would silently empty the list with nothing failing. The rows below are
//      written in the plugin's own shape.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeUser() {
  return usersService.createUser({
    email: `trusted-${++seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Ada',
  });
}

/** A grant in exactly the shape `verify-two-factor.mjs` writes. */
async function trustDevice(userId: string, opts: { expired?: boolean } = {}) {
  const offset = opts.expired ? -60_000 : 30 * 24 * 60 * 60 * 1000;
  return adminDb.verification.create({
    data: {
      identifier: `${TRUST_DEVICE_PREFIX}${Math.random().toString(36).slice(2).padEnd(32, 'x')}`,
      value: userId,
      expiresAt: new Date(Date.now() + offset),
    },
  });
}

describe('listTrustedDevices', () => {
  it('returns the user’s own live grants, newest first', async () => {
    const user = await makeUser();
    const older = await trustDevice(user.id);
    await new Promise((r) => setTimeout(r, 5));
    const newer = await trustDevice(user.id);

    const devices = await twoFactorService.listTrustedDevices(user.id);

    expect(devices.map((d) => d.id)).toEqual([newer.id, older.id]);
    expect(devices[0]!.trustedAt).toMatch(/^\d{4}-/);
    expect(devices[0]!.expiresAt).toMatch(/^\d{4}-/);
  });

  it('EXCLUDES an expired grant — a revoke on it would change nothing', async () => {
    const user = await makeUser();
    await trustDevice(user.id, { expired: true });

    expect(await twoFactorService.listTrustedDevices(user.id)).toEqual([]);
  });

  it('never returns another user’s grant', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    await trustDevice(theirs.id);

    expect(await twoFactorService.listTrustedDevices(mine.id)).toEqual([]);
  });

  it('ignores a verification row that is NOT a device grant', async () => {
    // The table is Better-Auth's catch-all: password resets and invites live
    // here too. Listing them as "devices you trusted" would offer a revoke that
    // silently breaks a password reset.
    const user = await makeUser();
    await adminDb.verification.create({
      data: {
        identifier: `reset-password:${user.id}-token`,
        value: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    expect(await twoFactorService.listTrustedDevices(user.id)).toEqual([]);
  });
});

describe('revokeTrustedDevice — the ownership scope IS the authorization', () => {
  it('revokes the caller’s own grant and reports it', async () => {
    const user = await makeUser();
    const grant = await trustDevice(user.id);

    expect(await twoFactorService.revokeTrustedDevice(user.id, grant.id)).toBe(true);
    expect(await twoFactorService.listTrustedDevices(user.id)).toEqual([]);
  });

  it('REFUSES another user’s grant, and leaves it standing', async () => {
    // The regression that matters. `id` arrives from a request body; without the
    // `value: userId` pairing this call would delete a stranger's device grant
    // and report success.
    const attacker = await makeUser();
    const victim = await makeUser();
    const grant = await trustDevice(victim.id);

    expect(await twoFactorService.revokeTrustedDevice(attacker.id, grant.id)).toBe(false);

    const stillThere = await twoFactorService.listTrustedDevices(victim.id);
    expect(stillThere.map((d) => d.id)).toEqual([grant.id]);
  });

  it('REFUSES a verification row that is not a device grant', async () => {
    // The second half of the same guard: owning the row is not enough, it must
    // also BE a device grant. Otherwise a user could delete their own pending
    // email-change token through this door and get a 200 for it.
    const user = await makeUser();
    const reset = await adminDb.verification.create({
      data: {
        identifier: `reset-password:${user.id}-token`,
        value: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    expect(await twoFactorService.revokeTrustedDevice(user.id, reset.id)).toBe(false);
    expect(await adminDb.verification.findUnique({ where: { id: reset.id } })).not.toBeNull();
  });

  it('reports false for an id that does not exist', async () => {
    const user = await makeUser();

    expect(await twoFactorService.revokeTrustedDevice(user.id, 'ver_nope')).toBe(false);
  });
});

describe('revokeAllTrustedDevices', () => {
  it('clears the caller’s grants and nobody else’s', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    await trustDevice(mine.id);
    await trustDevice(mine.id);
    const survivor = await trustDevice(theirs.id);

    expect(await twoFactorService.revokeAllTrustedDevices(mine.id)).toBe(2);
    expect(await twoFactorService.listTrustedDevices(mine.id)).toEqual([]);
    expect((await twoFactorService.listTrustedDevices(theirs.id)).map((d) => d.id)).toEqual([
      survivor.id,
    ]);
  });

  it('leaves the caller’s OTHER verification rows alone', async () => {
    const user = await makeUser();
    await trustDevice(user.id);
    const reset = await adminDb.verification.create({
      data: {
        identifier: `reset-password:${user.id}-token`,
        value: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await twoFactorService.revokeAllTrustedDevices(user.id);

    expect(await adminDb.verification.findUnique({ where: { id: reset.id } })).not.toBeNull();
  });

  it('is idempotent — revoking nothing is not an error', async () => {
    const user = await makeUser();

    expect(await twoFactorService.revokeAllTrustedDevices(user.id)).toBe(0);
  });
});
