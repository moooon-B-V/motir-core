import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { passkeyService } from '@/lib/services/passkeyService';
import { passkeyRepository } from '@/lib/repositories/passkeyRepository';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { toTwoFactorStatusDTO } from '@/lib/mappers/twoFactorMappers';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Story MOTIR-1214 · Subtask MOTIR-3611 — the passkey read, and `passkey` in the
// two-factor method set.
//
// Two halves, and the second is where the value is. The service/repository half
// is a plain read and is asserted against real Postgres (CLAUDE.md: never mock
// the DB). The MAPPER half is pure, and it is the seam Story MOTIR-1215 (2FA
// enforcement) consumes — so `methods` and `primaryMethod` are asserted
// separately on every interesting row, because the whole point of this card is
// that they stopped having the same answer.

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
    email: `passkey-${++seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Passkey Person',
  });
  if (enabled) {
    await adminDb.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
  }
  return user;
}

async function addPasskey(userId: string, name: string | null, overrides: { at?: Date } = {}) {
  return adminDb.passkey.create({
    data: {
      name,
      publicKey: `pk-${name ?? 'unnamed'}`,
      userId,
      credentialID: `cred-${++seq}`,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
      transports: 'internal',
      aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503',
      ...(overrides.at ? { createdAt: overrides.at } : {}),
    },
  });
}

describe('passkeyService.listForUser', () => {
  it('returns the user’s passkeys oldest first', async () => {
    const user = await makeUser();
    await addPasskey(user.id, 'Phone', { at: new Date('2026-02-01T00:00:00.000Z') });
    await addPasskey(user.id, 'Laptop', { at: new Date('2026-01-01T00:00:00.000Z') });

    const rows = await passkeyService.listForUser(user.id);

    // Oldest first is the only order a person can predict: `name` is nullable
    // and `id` is a cuid, so registration time is the sole stable key.
    expect(rows.map((r) => r.name)).toEqual(['Laptop', 'Phone']);
  });

  it('DROPS the credential material — nothing but identity and provenance crosses', async () => {
    const user = await makeUser();
    await addPasskey(user.id, 'Laptop');

    const [dto] = await passkeyService.listForUser(user.id);

    // Asserted as an exact key set, not field by field: a field ADDED to the
    // Prisma model later must not reach a client payload by being spread
    // through, and only a whole-shape assertion catches that.
    expect(Object.keys(dto!).sort()).toEqual(['backedUp', 'createdAt', 'deviceType', 'id', 'name']);
  });

  it('emits `createdAt` as an ISO string — a `Date` does not survive the props trip', async () => {
    const user = await makeUser();
    await addPasskey(user.id, 'Laptop', { at: new Date('2026-01-01T12:34:56.000Z') });

    const [dto] = await passkeyService.listForUser(user.id);

    expect(dto?.createdAt).toBe('2026-01-01T12:34:56.000Z');
  });

  it('keeps an unnamed passkey’s `name` null rather than inventing a label', async () => {
    const user = await makeUser();
    await addPasskey(user.id, null);

    const [dto] = await passkeyService.listForUser(user.id);

    // A server-side default would make an unnamed row indistinguishable from one
    // a person deliberately named. The pane owns the fallback.
    expect(dto?.name).toBeNull();
  });

  it('is scoped to the user — one account never sees another’s credentials', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    await addPasskey(mine.id, 'Mine');
    await addPasskey(theirs.id, 'Theirs');

    expect((await passkeyService.listForUser(mine.id)).map((r) => r.name)).toEqual(['Mine']);
    expect(await passkeyRepository.countByUserId(mine.id)).toBe(1);
  });

  it('answers an empty list and a zero count for an account with none', async () => {
    const user = await makeUser();

    expect(await passkeyService.listForUser(user.id)).toEqual([]);
    expect(await passkeyService.countForUser(user.id)).toBe(0);
  });
});

describe('toTwoFactorStatusDTO — `methods` is enrolment, `primaryMethod` is the challenge', () => {
  const base = { backupCodesRemaining: 0, backupCodesTotal: 10 };

  it('reproduces today’s answer exactly when there are no passkeys', () => {
    // The regression guard for the widening: an account with no passkey must be
    // described exactly as it was before this card existed.
    expect(
      toTwoFactorStatusDTO({ enabled: false, enrolment: null, passkeyCount: 0, ...base }),
    ).toEqual({ enabled: false, methods: [], primaryMethod: null, ...base });

    expect(
      toTwoFactorStatusDTO({
        enabled: true,
        enrolment: { verified: true },
        passkeyCount: 0,
        ...base,
      }),
    ).toEqual({ enabled: true, methods: ['totp', 'email'], primaryMethod: 'totp', ...base });

    expect(
      toTwoFactorStatusDTO({ enabled: true, enrolment: null, passkeyCount: 0, ...base }),
    ).toEqual({ enabled: true, methods: ['email'], primaryMethod: 'email', ...base });
  });

  it('counts a passkey with `enabled: false` — the case the old shape got wrong', () => {
    // THE row this card exists for. The passkey plugin never touches
    // `user.twoFactorEnabled`, so this account is genuinely multi-factor (user
    // verification is required) while the flag is off. Gating `passkey` behind
    // `enabled` would report exactly this person as having no second factor, and
    // MOTIR-1215 would then demand an authenticator app of the user who did the
    // best available thing.
    const dto = toTwoFactorStatusDTO({
      enabled: false,
      enrolment: null,
      passkeyCount: 2,
      ...base,
    });

    expect(dto.methods).toEqual(['passkey']);
    expect(dto.enabled).toBe(false);
    // And still no challenge: `primaryMethod` is about the step between the
    // password and the session, and there is no such step here.
    expect(dto.primaryMethod).toBeNull();
  });

  it('holds both when a passkey sits beside a confirmed authenticator', () => {
    const dto = toTwoFactorStatusDTO({
      enabled: true,
      enrolment: { verified: true },
      passkeyCount: 1,
      ...base,
    });

    expect(dto.methods).toEqual(['totp', 'email', 'passkey']);
    expect(dto.primaryMethod).toBe('totp');
  });

  it('falls to email when 2FA is on with no confirmed authenticator', () => {
    const dto = toTwoFactorStatusDTO({
      enabled: true,
      enrolment: { verified: false },
      passkeyCount: 3,
      ...base,
    });

    expect(dto.methods).toEqual(['email', 'passkey']);
    expect(dto.primaryMethod).toBe('email');
  });

  it('never returns `passkey` as `primaryMethod`, across the whole input space', () => {
    // Exhaustive rather than exemplary: `primaryMethod` used to be `methods[0]`,
    // and the regression that would reintroduce it reads as a simplification. A
    // loop over every combination is what makes that edit fail a test rather than
    // ship a challenge screen offering a credential it cannot ask for.
    for (const enabled of [true, false]) {
      for (const enrolment of [null, { verified: true }, { verified: false }]) {
        for (const passkeyCount of [0, 1, 5]) {
          const dto = toTwoFactorStatusDTO({ enabled, enrolment, passkeyCount, ...base });
          expect(dto.primaryMethod).not.toBe('passkey');
          expect(dto.methods.includes('passkey')).toBe(passkeyCount >= 1);
        }
      }
    }
  });
});

describe('twoFactorService.getStatus sources the count from the passkey read', () => {
  it('reports `passkey` in `methods` for an account with 2FA off and a passkey on', async () => {
    const user = await makeUser(false);
    await addPasskey(user.id, 'Laptop');

    const status = await twoFactorService.getStatus(user.id);

    expect(status.enabled).toBe(false);
    expect(status.methods).toEqual(['passkey']);
    expect(status.primaryMethod).toBeNull();
    // The contract MOTIR-1215 reads: satisfied is `methods.length > 0`, not
    // `enabled`.
    expect(status.methods.length > 0).toBe(true);
  });

  it('leaves an account with neither exactly as it was', async () => {
    const user = await makeUser(false);

    const status = await twoFactorService.getStatus(user.id);

    expect(status.methods).toEqual([]);
    expect(status.primaryMethod).toBeNull();
  });
});
