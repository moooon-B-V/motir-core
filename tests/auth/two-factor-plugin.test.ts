import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_ISSUER,
  TWO_FACTOR_OTP_DIGITS,
  TWO_FACTOR_OTP_PERIOD_MINUTES,
  TWO_FACTOR_TOTP_PERIOD_SECONDS,
  TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS,
} from '@/lib/auth/twoFactorConfig';

// Story MOTIR-1213 · Subtask MOTIR-1217 — schema + plugin wiring.
//
// The deliverable is a REGISTRATION and a MIGRATION, so this suite asserts the
// two things that can silently be wrong about them:
//
//   1. The plugin is actually mounted. A `plugins: [...]` entry that throws at
//      module load, or a plugin whose endpoints never register, fails the same
//      way — the app boots and the 2FA routes 404 at the moment a user needs
//      them. `auth.api.*` is the surface those endpoints are exposed on, so
//      naming them is the cheapest proof they exist.
//   2. The migration and the plugin agree about the table. The plugin addresses
//      `db.twoFactor` with four exact camelCase keys through its adapter, and
//      renaming one in schema.prisma breaks it at RUNTIME with no typecheck
//      error. So the row is written and read back here through Prisma.
//
// Real Postgres, truncate between tests (CLAUDE.md: never mock the DB).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the twoFactor plugin is registered', () => {
  it('constructs the auth instance without throwing', async () => {
    const { auth } = await import('@/lib/auth');
    expect(auth).toBeDefined();
  });

  it('mounts every endpoint the story needs — enrol, disable, and all three challenge methods', async () => {
    const { auth } = await import('@/lib/auth');

    // Enrolment + management (session-authenticated).
    expect(typeof auth.api.enableTwoFactor).toBe('function');
    expect(typeof auth.api.disableTwoFactor).toBe('function');
    expect(typeof auth.api.getTOTPURI).toBe('function');
    expect(typeof auth.api.generateBackupCodes).toBe('function');
    expect(typeof auth.api.viewBackupCodes).toBe('function');

    // The three ways a challenge is answered. All three are load-bearing for
    // the story's acceptance recipe: authenticator app, "email me a code",
    // and a recovery code. Note the exact spelling — the OTP verifier is
    // `verifyTwoFactorOTP`, NOT the `verifyOTP` the symmetry with `verifyTOTP`
    // suggests, and getting it wrong is invisible until the challenge screen
    // calls a method that does not exist.
    expect(typeof auth.api.verifyTOTP).toBe('function');
    expect(typeof auth.api.sendTwoFactorOTP).toBe('function');
    expect(typeof auth.api.verifyTwoFactorOTP).toBe('function');
    expect(typeof auth.api.verifyBackupCode).toBe('function');
  });

  it('leaves the pre-existing plugins mounted — this is an addition, not a replacement', async () => {
    const { auth } = await import('@/lib/auth');

    // deviceAuthorization (MOTIR-1865) shares the same handler. A plugin array
    // edit that dropped it would break `motir login` with nothing else failing.
    expect(typeof auth.api.deviceCode).toBe('function');
    expect(typeof auth.api.getSession).toBe('function');
  });
});

describe('the two-factor schema', () => {
  it('every existing user is twoFactorEnabled=false — the migration needs no backfill', async () => {
    const user = await usersService.createUser({
      email: 'ada@example.com',
      password: 'hunter2hunter2',
      name: 'Ada',
    });

    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.twoFactorEnabled).toBe(false);
  });

  it('round-trips a TwoFactor row under the exact field names the plugin adapter uses', async () => {
    const user = await usersService.createUser({
      email: 'grace@example.com',
      password: 'hunter2hunter2',
      name: 'Grace',
    });

    // These four keys are the plugin's own (`plugins/two-factor/schema.mjs`).
    // If schema.prisma renamed one, this create would not compile — which is
    // the point of writing it out rather than spreading a fixture.
    const created = await adminDb.twoFactor.create({
      data: {
        secret: 'encrypted-secret',
        backupCodes: 'encrypted-joined-codes',
        userId: user.id,
        verified: false,
      },
    });

    const read = await adminDb.twoFactor.findUniqueOrThrow({ where: { id: created.id } });
    expect(read.secret).toBe('encrypted-secret');
    expect(read.backupCodes).toBe('encrypted-joined-codes');
    expect(read.userId).toBe(user.id);
    expect(read.verified).toBe(false);
  });

  it('defaults `verified` to true, matching the plugin default', async () => {
    const user = await usersService.createUser({
      email: 'alan@example.com',
      password: 'hunter2hunter2',
      name: 'Alan',
    });

    const created = await adminDb.twoFactor.create({
      data: { secret: 's', backupCodes: 'b', userId: user.id },
    });

    expect(created.verified).toBe(true);
  });

  it('cascades with the user — 2FA material is auth substrate, not audit', async () => {
    const user = await usersService.createUser({
      email: 'edsger@example.com',
      password: 'hunter2hunter2',
      name: 'Edsger',
    });
    await adminDb.twoFactor.create({
      data: { secret: 's', backupCodes: 'b', userId: user.id },
    });

    await adminDb.user.delete({ where: { id: user.id } });

    expect(await adminDb.twoFactor.count({ where: { userId: user.id } })).toBe(0);
  });

  it('admits a SECOND row for one user — `userId` is indexed, deliberately not unique', async () => {
    // The plugin runs `deleteMany({userId}) → create(...)` on enable, so in
    // practice a user holds 0 or 1. A `@unique` here would turn a lost race
    // between two concurrent enrolments into a raw P2002 thrown INSIDE the
    // plugin, where no typed error can catch it. This asserts the shape we
    // chose, so a later "tighten it to unique" edit has to argue with a test.
    const user = await usersService.createUser({
      email: 'barbara@example.com',
      password: 'hunter2hunter2',
      name: 'Barbara',
    });

    await adminDb.twoFactor.create({ data: { secret: 'a', backupCodes: 'x', userId: user.id } });
    await adminDb.twoFactor.create({ data: { secret: 'b', backupCodes: 'y', userId: user.id } });

    expect(await adminDb.twoFactor.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe('the two-factor configuration', () => {
  // The constants are what the Security pane and the challenge screen will
  // RENDER (MOTIR-1220 / MOTIR-1221), so a change to one of them changes user-
  // visible copy. Pinning them here makes that change deliberate.
  it('pins the numbers the story’s acceptance recipe names', () => {
    expect(TWO_FACTOR_BACKUP_CODE_COUNT).toBe(10);
    expect(TWO_FACTOR_OTP_DIGITS).toBe(6);
    expect(TWO_FACTOR_TOTP_PERIOD_SECONDS).toBe(30);
    expect(TWO_FACTOR_ISSUER).toBe('Motir');
    // "don't ask again on this device for 30 days"
    expect(TWO_FACTOR_TRUST_DEVICE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('keeps the OTP period in MINUTES — the unit the plugin and the email agree on', () => {
    // `otpOptions.period` is minutes (the plugin's default is 3) and the email
    // template renders the same number as "expires in N minutes". A value that
    // looked like seconds here would send a code claiming a 180-minute life.
    expect(TWO_FACTOR_OTP_PERIOD_MINUTES).toBeGreaterThan(0);
    expect(TWO_FACTOR_OTP_PERIOD_MINUTES).toBeLessThanOrEqual(10);
  });
});
