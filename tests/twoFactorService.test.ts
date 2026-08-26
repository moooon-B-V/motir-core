import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { twoFactorRepository } from '@/lib/repositories/twoFactorRepository';
import {
  decodeBackupCodes,
  encodeBackupCodes,
  generateBackupCodes,
} from '@/lib/twoFactor/backupCodes';
import {
  BackupCodesUnreadableError,
  InvalidBackupCodeError,
  TwoFactorNotEnabledError,
} from '@/lib/twoFactor/errors';
import { UserNotFoundError } from '@/lib/users/errors';
import { TWO_FACTOR_BACKUP_CODE_COUNT } from '@/lib/auth/twoFactorConfig';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { warmPool } from './helpers/warmPool';

// Story MOTIR-1213 · Subtask MOTIR-1218 — the two-factor service + repository.
//
// Real Postgres, truncate between tests (CLAUDE.md: never mock the DB). The
// concurrency block at the bottom is the one that matters most and is the
// reason `findByUserIdForUpdate` exists at all.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeUser(enabled = false) {
  const user = await usersService.createUser({
    email: `two-factor-${++seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Ada',
  });
  if (enabled) {
    await adminDb.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
  }
  return user;
}

/** Seed an enrolment row the way the plugin's `/two-factor/enable` would. */
async function enrol(userId: string, codes: string[], verified = true) {
  return adminDb.twoFactor.create({
    data: {
      secret: 'encrypted-totp-secret',
      backupCodes: await encodeBackupCodes(codes),
      userId,
      verified,
    },
  });
}

describe('the recovery-code codec', () => {
  it('round-trips a set', async () => {
    const codes = ['aaaaa-11111', 'bbbbb-22222'];
    expect(await decodeBackupCodes(await encodeBackupCodes(codes))).toEqual(codes);
  });

  it('does not store the codes in the clear', async () => {
    const stored = await encodeBackupCodes(['aaaaa-11111']);
    expect(stored).not.toContain('aaaaa-11111');
  });

  it('THROWS on a column it cannot decode — never a silent empty set', async () => {
    // The distinction the type exists for: an empty set means "you spent them
    // all", an undecodable one means "the secret is wrong". Collapsing them
    // would tell a locked-out user their code was invalid for an operator's
    // mistake.
    await expect(decodeBackupCodes('not-ciphertext')).rejects.toBeInstanceOf(
      BackupCodesUnreadableError,
    );
  });

  it('mints codes in the plugin’s own shape, and never repeats one', () => {
    const codes = generateBackupCodes(TWO_FACTOR_BACKUP_CODE_COUNT);
    expect(codes).toHaveLength(TWO_FACTOR_BACKUP_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('getStatus', () => {
  it('reports OFF for an account with no enrolment', async () => {
    const user = await makeUser();

    expect(await twoFactorService.getStatus(user.id)).toEqual({
      enabled: false,
      methods: [],
      primaryMethod: null,
      backupCodesRemaining: 0,
      backupCodesTotal: TWO_FACTOR_BACKUP_CODE_COUNT,
    });
  });

  it('offers TOTP first and email as the fallback once enrolment is confirmed', async () => {
    const user = await makeUser(true);
    await enrol(user.id, generateBackupCodes(10));

    const status = await twoFactorService.getStatus(user.id);
    expect(status.enabled).toBe(true);
    expect(status.methods).toEqual(['totp', 'email']);
    expect(status.primaryMethod).toBe('totp');
    expect(status.backupCodesRemaining).toBe(10);
  });

  it('WITHHOLDS totp while enrolment is unconfirmed — the plugin withholds it too', async () => {
    // `verified: false` is the window between "the QR was shown" and "a code
    // from it was accepted". The challenge screen must not offer a method whose
    // secret the user may never have scanned.
    const user = await makeUser(true);
    await enrol(user.id, generateBackupCodes(10), false);

    const status = await twoFactorService.getStatus(user.id);
    expect(status.methods).toEqual(['email']);
    expect(status.primaryMethod).toBe('email');
  });

  it('reports no methods for a STALE row on a disabled account', async () => {
    // An abandoned enable leaves a row behind. Nothing will be asked for, so
    // nothing is offered.
    const user = await makeUser(false);
    await enrol(user.id, generateBackupCodes(10));

    const status = await twoFactorService.getStatus(user.id);
    expect(status.enabled).toBe(false);
    expect(status.methods).toEqual([]);
    expect(status.primaryMethod).toBeNull();
  });

  it('answers 0 remaining rather than throwing when the column cannot be read', async () => {
    // The one place an unreadable column is swallowed: a pane that 500s tells
    // the user nothing, while "0 of 10" tells them to regenerate — the right
    // action under a rotated secret as well as a spent set.
    const user = await makeUser(true);
    await adminDb.twoFactor.create({
      data: { secret: 's', backupCodes: 'not-ciphertext', userId: user.id },
    });

    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(0);
  });

  it('throws UserNotFoundError for an id that no longer exists', async () => {
    await expect(twoFactorService.getStatus('user_gone')).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe('consumeBackupCode', () => {
  it('spends exactly one code and leaves the rest', async () => {
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);

    expect(await twoFactorService.consumeBackupCode(user.id, codes[3]!)).toEqual({ remaining: 9 });

    const row = await twoFactorRepository.findByUserId(user.id);
    const left = await decodeBackupCodes(row!.backupCodes);
    expect(left).toHaveLength(9);
    expect(left).not.toContain(codes[3]);
    expect(left).toContain(codes[0]);
  });

  it('is SINGLE-USE — the second attempt at the same code is refused', async () => {
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);

    await twoFactorService.consumeBackupCode(user.id, codes[0]!);
    await expect(twoFactorService.consumeBackupCode(user.id, codes[0]!)).rejects.toBeInstanceOf(
      InvalidBackupCodeError,
    );
    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(9);
  });

  it('refuses a code that was never issued', async () => {
    const user = await makeUser(true);
    await enrol(user.id, generateBackupCodes(10));

    await expect(twoFactorService.consumeBackupCode(user.id, 'zzzzz-99999')).rejects.toBeInstanceOf(
      InvalidBackupCodeError,
    );
  });

  it('refuses an account with no enrolment, with a typed error', async () => {
    const user = await makeUser();

    await expect(twoFactorService.consumeBackupCode(user.id, 'aaaaa-11111')).rejects.toBeInstanceOf(
      TwoFactorNotEnabledError,
    );
  });

  it('spends the LAST code and reports zero remaining', async () => {
    const user = await makeUser(true);
    const codes = generateBackupCodes(1);
    await enrol(user.id, codes);

    expect(await twoFactorService.consumeBackupCode(user.id, codes[0]!)).toEqual({ remaining: 0 });
    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(0);
  });

  it('touches only the caller’s own enrolment', async () => {
    const mine = await makeUser(true);
    const theirs = await makeUser(true);
    const shared = generateBackupCodes(5);
    await enrol(mine.id, shared);
    await enrol(theirs.id, shared);

    await twoFactorService.consumeBackupCode(mine.id, shared[0]!);

    expect((await twoFactorService.getStatus(mine.id)).backupCodesRemaining).toBe(4);
    expect((await twoFactorService.getStatus(theirs.id)).backupCodesRemaining).toBe(5);
  });
});

describe('regenerateBackupCodes', () => {
  it('returns a fresh plaintext set and invalidates every previous code', async () => {
    const user = await makeUser(true);
    const old = generateBackupCodes(10);
    await enrol(user.id, old);

    const minted = await twoFactorService.regenerateBackupCodes(user.id);
    expect(minted.codes).toHaveLength(TWO_FACTOR_BACKUP_CODE_COUNT);
    expect(minted.remaining).toBe(TWO_FACTOR_BACKUP_CODE_COUNT);
    expect(minted.codes).not.toContain(old[0]);

    // A code from the old set no longer works; one from the new set does.
    await expect(twoFactorService.consumeBackupCode(user.id, old[0]!)).rejects.toBeInstanceOf(
      InvalidBackupCodeError,
    );
    await expect(twoFactorService.consumeBackupCode(user.id, minted.codes[0]!)).resolves.toEqual({
      remaining: TWO_FACTOR_BACKUP_CODE_COUNT - 1,
    });
  });

  it('stores the set encrypted — the plaintext exists only in the response', async () => {
    const user = await makeUser(true);
    await enrol(user.id, generateBackupCodes(10));

    const minted = await twoFactorService.regenerateBackupCodes(user.id);
    const row = await twoFactorRepository.findByUserId(user.id);
    expect(row!.backupCodes).not.toContain(minted.codes[0]);
    expect(await decodeBackupCodes(row!.backupCodes)).toEqual(minted.codes);
  });

  it('refuses an account with no enrolment', async () => {
    const user = await makeUser();

    await expect(twoFactorService.regenerateBackupCodes(user.id)).rejects.toBeInstanceOf(
      TwoFactorNotEnabledError,
    );
  });
});

describe('disable', () => {
  it('drops the enrolment row and clears the flag together', async () => {
    const user = await makeUser(true);
    await enrol(user.id, generateBackupCodes(10));

    await twoFactorService.disable(user.id);

    expect(await twoFactorRepository.findByUserId(user.id)).toBeNull();
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.twoFactorEnabled).toBe(false);
    expect((await twoFactorService.getStatus(user.id)).methods).toEqual([]);
  });

  it('is idempotent — disabling an account that is already off is not an error', async () => {
    const user = await makeUser();

    await expect(twoFactorService.disable(user.id)).resolves.toBeUndefined();
    await expect(twoFactorService.disable(user.id)).resolves.toBeUndefined();
  });
});

// ── The property the FOR UPDATE lock exists for ─────────────────────────────
//
// The race only manifests when the two transactions truly run in parallel — a
// COLD pool serialises them on one physical connection and hides it, and the
// assertion then passes whether or not the lock exists. `warmPool` is the shared
// helper (tests/helpers/warmPool.ts), NOT a local copy: its own header explains
// why, and the RLS raw-statement ratchet enforces it — a second `SELECT 1` under
// `tests/` raises a ceiling that only ever falls.

describe('concurrency — a recovery code is spent at most ONCE under a warm pool', () => {
  it('two concurrent spends of the SAME code: one succeeds, one is refused', async () => {
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);
    await warmPool();

    const results = await Promise.allSettled([
      twoFactorService.consumeBackupCode(user.id, codes[0]!),
      twoFactorService.consumeBackupCode(user.id, codes[0]!),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A TYPED domain error, never a raw Prisma code — the loser sees exactly
    // what a user typing an already-spent code sees.
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidBackupCodeError);

    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(9);
  });

  it('two concurrent spends of DIFFERENT codes: both succeed, and BOTH are gone', async () => {
    // The failure this catches is the lost update, not a double-spend: without
    // the lock each transaction writes back a set missing only its own code, so
    // the second write RESTORES the first's code and the count reads 9 instead
    // of 8. Asserting the count alone would pass; asserting membership is what
    // makes it a real test.
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);
    await warmPool();

    const results = await Promise.allSettled([
      twoFactorService.consumeBackupCode(user.id, codes[0]!),
      twoFactorService.consumeBackupCode(user.id, codes[1]!),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const row = await twoFactorRepository.findByUserId(user.id);
    const left = await decodeBackupCodes(row!.backupCodes);
    expect(left).toHaveLength(8);
    expect(left).not.toContain(codes[0]);
    expect(left).not.toContain(codes[1]);
  });

  it('ten concurrent spends of ten distinct codes leave the set EMPTY', async () => {
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);
    await warmPool(10);

    const results = await Promise.allSettled(
      codes.map((code) => twoFactorService.consumeBackupCode(user.id, code)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect((await twoFactorService.getStatus(user.id)).backupCodesRemaining).toBe(0);
  });

  it('a regenerate racing a spend does not resurrect the spent code', async () => {
    // Whichever ordering the lock produces is legitimate — what must NOT happen
    // is the mint landing on top of a set the spend had already shortened while
    // the spend reports success. So: either the spend won and its code is
    // absent from a 9-code set, or the regenerate won and the spend is refused
    // against the fresh set. Both are consistent; an inconsistent outcome is a
    // 10-code set that still contains a code the service said it spent.
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);
    await warmPool();

    const [spend, mint] = await Promise.allSettled([
      twoFactorService.consumeBackupCode(user.id, codes[0]!),
      twoFactorService.regenerateBackupCodes(user.id),
    ]);

    const row = await twoFactorRepository.findByUserId(user.id);
    const left = await decodeBackupCodes(row!.backupCodes);

    if (spend!.status === 'fulfilled') {
      // The spend committed. Either it went first and the mint replaced the
      // set (the old code is gone with the rest of the old set), or it went
      // second against the mint's set — impossible, since its code is not in
      // the mint. Either way the spent code must not be present.
      expect(left).not.toContain(codes[0]);
    } else {
      expect(spend!.reason).toBeInstanceOf(InvalidBackupCodeError);
    }
    // The mint always succeeds — it derives nothing from the previous set.
    expect(mint!.status).toBe('fulfilled');
    expect(left).not.toContain(codes[0]);
  });

  it('a disable racing a spend leaves NOTHING behind — no orphan row, no set flag', async () => {
    const user = await makeUser(true);
    const codes = generateBackupCodes(10);
    await enrol(user.id, codes);
    await warmPool();

    const [, disable] = await Promise.allSettled([
      twoFactorService.consumeBackupCode(user.id, codes[0]!),
      twoFactorService.disable(user.id),
    ]);
    expect(disable!.status).toBe('fulfilled');

    // The invariant: the two halves of a disable never come apart. A surviving
    // row with a cleared flag leaves live credentials on an unchallenged
    // account; a surviving flag with no row is a lockout.
    expect(await twoFactorRepository.findByUserId(user.id)).toBeNull();
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.twoFactorEnabled).toBe(false);
  });
});
