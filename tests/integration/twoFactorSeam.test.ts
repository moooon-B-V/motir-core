import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { twoFactorRepository } from '@/lib/repositories/twoFactorRepository';
import { decodeBackupCodes } from '@/lib/twoFactor/backupCodes';
import { InvalidBackupCodeError } from '@/lib/twoFactor/errors';
import {
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_ISSUER,
  TWO_FACTOR_TOTP_PERIOD_SECONDS,
} from '@/lib/auth/twoFactorConfig';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { warmPool } from '../helpers/warmPool';
import { totpFromSetupKey } from '../e2e/_helpers/totp';

// Story 8.11 · Subtask MOTIR-1222 — the STORY-LEVEL seam.
//
// Each subtask's own units already cover its own half. What none of them can
// cover is the join: Better-Auth's plugin WRITES `two_factor` through its
// adapter, and Motir READS the same row through `twoFactorService.getStatus`.
// Those are two independent pieces of code addressing one table by field name,
// and a rename on either side is invisible to a unit test that mocks the other.
// So this file drives the REAL endpoints and reads back through the REAL DTO.
//
// ⚠️ THE TOTP ORACLE IS WRITTEN OUT, NOT IMPORTED. Generating the confirming
// code with the same `createOTP` the plugin verifies with would assert that a
// function agrees with itself. `totpFor` below is RFC 6238 from `node:crypto` —
// SHA-1 over a big-endian counter, dynamic truncation — so a change to the
// plugin's algorithm fails HERE instead of passing quietly.
//
// Real Postgres, truncate between tests (CLAUDE.md).

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** RFC 6238, independent of the implementation under test. */
function totpFor(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / (TWO_FACTOR_TOTP_PERIOD_SECONDS * 1000));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(truncated % 10 ** 6).padStart(6, '0');
}

/** Join a `set-cookie` header into the `cookie` request header form. */
function cookieHeader(setCookie: string | null): string {
  expect(setCookie, 'no set-cookie header').toBeTruthy();
  return setCookie!
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(';')[0]!.trim())
    .join('; ');
}

let seq = 0;

/** A signed-in user, and the cookie header the plugin's endpoints authenticate with. */
async function signedInUser() {
  const email = `seam-${++seq}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Ada' });

  const res = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  return {
    user,
    email,
    headers: new Headers({ cookie: cookieHeader(res.headers.get('set-cookie')) }),
  };
}

/**
 * Confirm an enrolment and return the REFRESHED headers.
 *
 * ⚠️ THE FIRST SUCCESSFUL `verifyTOTP` ROTATES THE SESSION — it creates a new
 * one, sets the cookie, and DELETES the old token
 * (`plugins/two-factor/totp/index.mjs`). So a caller holding the sign-in cookie
 * is unauthenticated the moment enrolment completes. A browser follows the
 * `Set-Cookie` and never notices; a server-side caller must re-read it, and this
 * test found out by getting `Unauthorized` on the next call.
 */
async function confirmEnrolment(userId: string, headers: Headers): Promise<Headers> {
  const secret = await storedSecret(userId);
  const res = await auth.api.verifyTOTP({
    body: { code: totpFor(secret) },
    headers,
    asResponse: true,
  });
  return new Headers({ cookie: cookieHeader(res.headers.get('set-cookie')) });
}

describe('the plugin writes and Motir reads the SAME row', () => {
  it('enable → the row exists, and the pane still says OFF until it is confirmed', async () => {
    const { user, headers } = await signedInUser();

    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers,
    });
    expect(enabled.totpURI).toContain('otpauth://totp/');
    expect(enabled.backupCodes).toHaveLength(TWO_FACTOR_BACKUP_CODE_COUNT);

    // The plugin wrote through its adapter; Motir reads through Prisma. This is
    // the assertion that catches a field rename between the two.
    const row = await twoFactorRepository.findByUserId(user.id);
    expect(row).not.toBeNull();
    expect(row!.verified).toBe(false);

    // And the DTO agrees with the row: unconfirmed enrolment is not 2FA.
    const status = await twoFactorService.getStatus(user.id);
    expect(status.enabled).toBe(false);
    expect(status.methods).toEqual([]);
    expect(status.primaryMethod).toBeNull();
  });

  it('the otpauth URI carries the configured issuer, digits and period', async () => {
    const { headers } = await signedInUser();

    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    const uri = new URL(enabled.totpURI.replace('otpauth://', 'https://'));

    expect(uri.searchParams.get('issuer')).toBe(TWO_FACTOR_ISSUER);
    expect(uri.searchParams.get('period')).toBe(String(TWO_FACTOR_TOTP_PERIOD_SECONDS));
    expect(uri.searchParams.get('digits')).toBe('6');
  });

  it('the E2E’s authenticator helper computes the SAME code as the server’s secret', async () => {
    // The E2E (MOTIR-1223) reads the base32 setup key off the enrol screen and
    // HMACs its DECODED BYTES, exactly as 1Password would. The server HMACs the
    // RAW secret string. Those are the same bytes only because the URI is
    // `base32.encode(rawSecret)` — and getting that wrong produces codes that
    // never match, a failure that looks like a broken feature rather than a
    // broken helper. Tying the two together HERE, against a real enrolment,
    // means the E2E cannot fail for that reason without this failing first and
    // far more cheaply.
    const { user, headers } = await signedInUser();
    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });

    const setupKey = new URL(enabled.totpURI.replace('otpauth://', 'https://')).searchParams.get(
      'secret',
    )!;
    const at = Date.now();

    expect(totpFromSetupKey(setupKey, { at })).toBe(totpFor(await storedSecret(user.id), at));
  });

  it('confirm with a REAL code → the pane flips on, with both methods and ten codes', async () => {
    const { user, headers } = await signedInUser();
    await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });

    await confirmEnrolment(user.id, headers);

    const status = await twoFactorService.getStatus(user.id);
    expect(status.enabled).toBe(true);
    expect(status.methods).toEqual(['totp', 'email']);
    expect(status.primaryMethod).toBe('totp');
    expect(status.backupCodesRemaining).toBe(TWO_FACTOR_BACKUP_CODE_COUNT);
    expect(status.backupCodesTotal).toBe(TWO_FACTOR_BACKUP_CODE_COUNT);
  });

  it('a WRONG code leaves the enrolment unconfirmed', async () => {
    const { user, headers } = await signedInUser();
    await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });

    await expect(auth.api.verifyTOTP({ body: { code: '000000' }, headers })).rejects.toBeInstanceOf(
      Error,
    );

    expect((await twoFactorService.getStatus(user.id)).enabled).toBe(false);
  });

  it('the codes `enable` HANDED BACK are the codes the column holds', async () => {
    // The seam the shown-once modal depends on: what the user writes down must
    // be what a later consume checks against. The column is encrypted, so this
    // also proves Motir's codec and the plugin's agree byte for byte.
    const { user, headers } = await signedInUser();

    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    const row = await twoFactorRepository.findByUserId(user.id);

    expect(await decodeBackupCodes(row!.backupCodes)).toEqual(enabled.backupCodes);
  });

  it('a code from `enable` spends through MOTIR’s service and the pane sees it', async () => {
    const { user, headers } = await signedInUser();
    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    await confirmEnrolment(user.id, headers);

    await twoFactorService.consumeBackupCode(user.id, enabled.backupCodes[0]!);

    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(
      TWO_FACTOR_BACKUP_CODE_COUNT - 1,
    );
  });

  it('disable → the row is gone and the pane says OFF', async () => {
    const { user, headers } = await signedInUser();
    await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    const confirmed = await confirmEnrolment(user.id, headers);

    await auth.api.disableTwoFactor({ body: { password: PASSWORD }, headers: confirmed });

    expect(await twoFactorRepository.findByUserId(user.id)).toBeNull();
    const status = await twoFactorService.getStatus(user.id);
    expect(status.enabled).toBe(false);
    expect(status.methods).toEqual([]);
  });
});

describe('confirming an enrolment ROTATES the session', () => {
  it('invalidates the cookie the reader signed in with', async () => {
    // Not a quirk to route around — a property a client has to respect. The
    // browser follows the Set-Cookie transparently; anything holding the old
    // token is logged out, which is what the settings pane's enrol flow relies
    // on the browser doing for it.
    const { user, headers } = await signedInUser();
    await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });

    const refreshed = await confirmEnrolment(user.id, headers);

    await expect(
      auth.api.generateBackupCodes({ body: { password: PASSWORD }, headers }),
    ).rejects.toThrow(/unauthor/i);
    await expect(
      auth.api.generateBackupCodes({ body: { password: PASSWORD }, headers: refreshed }),
    ).resolves.toBeTruthy();
  });
});

describe('a recovery code is spent at most once, across BOTH writers', () => {
  it('the plugin’s regenerate and Motir’s reader agree on the new set', async () => {
    const { user, headers } = await signedInUser();
    const first = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    const confirmed = await confirmEnrolment(user.id, headers);

    const regenerated = await auth.api.generateBackupCodes({
      body: { password: PASSWORD },
      headers: confirmed,
    });

    // The plugin replaced the set; Motir's consume must now reject the old ones
    // and accept the new. Two writers, one column.
    await expect(
      twoFactorService.consumeBackupCode(user.id, first.backupCodes[0]!),
    ).rejects.toBeInstanceOf(InvalidBackupCodeError);
    await expect(
      twoFactorService.consumeBackupCode(user.id, regenerated.backupCodes[0]!),
    ).resolves.toEqual({ remaining: TWO_FACTOR_BACKUP_CODE_COUNT - 1 });
  });

  it('two concurrent spends of one code: exactly one wins, under a warm pool', async () => {
    const { user, headers } = await signedInUser();
    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers });
    await confirmEnrolment(user.id, headers);
    await warmPool();

    const results = await Promise.allSettled([
      twoFactorService.consumeBackupCode(user.id, enabled.backupCodes[0]!),
      twoFactorService.consumeBackupCode(user.id, enabled.backupCodes[0]!),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidBackupCodeError);
    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(
      TWO_FACTOR_BACKUP_CODE_COUNT - 1,
    );
  });
});

/** The RAW TOTP seed, decrypted the way the plugin encrypted it. */
async function storedSecret(userId: string): Promise<string> {
  const row = await twoFactorRepository.findByUserId(userId);
  const { symmetricDecrypt } = await import('better-auth/crypto');
  return symmetricDecrypt({ key: process.env['BETTER_AUTH_SECRET']!, data: row!.secret });
}
