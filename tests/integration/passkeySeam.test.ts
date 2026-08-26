import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { passkeyService } from '@/lib/services/passkeyService';
import { passkeyRepository } from '@/lib/repositories/passkeyRepository';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { toPasskeyDTO } from '@/lib/mappers/passkeyMappers';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 8.12 · Subtask MOTIR-3614 — the STORY-LEVEL seam.
//
// Each subtask's own units cover its own half. What none of them can cover is
// the JOIN, and this story threads one new fact through four layers: a row the
// plugin writes through its own adapter, a repository that reads it, a mapper
// that decides what crosses, and a service that composes it with two-factor
// enrolment into the answer Story 8.13 will act on.
//
// Three joins are worth freezing, and they fail in three different ways:
//
//   1. KEY DRIFT. The plugin addresses `db.passkey` by exact camelCase key. A
//      rename in `schema.prisma` breaks it at runtime with no typecheck error,
//      and a unit that mocks the repository sees nothing.
//   2. A LEAK. `toPasskeyDTO` is the boundary that drops the credential
//      material, and the type alone will not catch a spread that puts it back —
//      an added field is assignable to a wider object. So the omissions are
//      asserted POSITIVELY, over a row that really carries all five.
//   3. A WRONG ANSWER ABOUT PROTECTION. `methods` now composes two sources, and
//      it is what 8.13 reads to decide whether somebody may keep working. It is
//      the seam most worth pinning against real rows rather than against a
//      hand-built argument object.
//
// Real Postgres, truncate between tests (CLAUDE.md: never mock the DB).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const PASSWORD = 'hunter2hunter2';
let seq = 0;

async function makeUser(twoFactorEnabled = false) {
  const user = await usersService.createUser({
    email: `passkey-seam-${++seq}@example.com`,
    password: PASSWORD,
    name: 'Ada Lovelace',
  });
  if (twoFactorEnabled) {
    await adminDb.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
  }
  return user;
}

/** A row carrying EVERY field, including the five that must not cross. */
async function insertPasskey(userId: string, overrides: Partial<{ name: string | null }> = {}) {
  return adminDb.passkey.create({
    data: {
      name: overrides.name === undefined ? 'MacBook Pro' : overrides.name,
      publicKey: 'cHVibGljLWtleS1tYXRlcmlhbA',
      userId,
      credentialID: `cred-${++seq}`,
      counter: 7,
      deviceType: 'multiDevice',
      backedUp: true,
      transports: 'internal,hybrid',
      aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503',
    },
  });
}

/** An enrolment row as the plugin writes it. `verified: false` is mid-enrolment. */
async function insertTwoFactor(userId: string, verified: boolean) {
  return adminDb.twoFactor.create({
    data: { secret: 'encrypted-secret', backupCodes: 'encrypted-codes', userId, verified },
  });
}

describe('a real row reaches the pane through the real mapper', () => {
  it('round-trips every field the DTO carries', async () => {
    const user = await makeUser();
    await insertPasskey(user.id);

    const [dto] = await passkeyService.listForUser(user.id);

    expect(dto?.name).toBe('MacBook Pro');
    expect(dto?.deviceType).toBe('multiDevice');
    expect(dto?.backedUp).toBe(true);
    // ISO string, not a `Date` — this shape is serialised into a Server
    // Component's props and a `Date` does not survive that trip.
    expect(typeof dto?.createdAt).toBe('string');
    expect(new Date(dto!.createdAt).getTime()).toBeGreaterThan(0);
  });

  it('DROPS the credential material — asserted positively, on a row that carries all of it', async () => {
    const user = await makeUser();
    const row = await insertPasskey(user.id);

    // The row really has them; the DTO really does not.
    expect(row.publicKey).toBe('cHVibGljLWtleS1tYXRlcmlhbA');
    expect(row.credentialID).toBeTruthy();
    expect(row.counter).toBe(7);
    expect(row.transports).toBe('internal,hybrid');
    expect(row.aaguid).toBeTruthy();

    const [dto] = await passkeyService.listForUser(user.id);
    const keys = Object.keys(dto!);

    for (const secret of ['publicKey', 'credentialID', 'counter', 'transports', 'aaguid']) {
      expect(keys).not.toContain(secret);
    }
    // The whole key set, not just the absences: an added field would otherwise
    // reach a client payload by being spread through and pass the loop above.
    expect(keys.sort()).toEqual(['backedUp', 'createdAt', 'deviceType', 'id', 'name']);
  });

  it('addresses the table under the plugin’s exact field names', async () => {
    // KEY DRIFT is the failure this asserts. `schema.prisma` may rename the
    // COLUMNS freely (they are `@map`ped), but the Prisma-side names are the
    // plugin's adapter's, and renaming one breaks passkeys at runtime with the
    // build green. Reading them back off a real row is what notices.
    const user = await makeUser();
    await insertPasskey(user.id);

    const [row] = await passkeyRepository.findManyByUserId(user.id);

    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual([
      'aaguid',
      'backedUp',
      'counter',
      'createdAt',
      'credentialID',
      'deviceType',
      'id',
      'name',
      'publicKey',
      'transports',
      'userId',
    ]);
    // And the mapper reads that row directly, without a shape adapter in between.
    expect(toPasskeyDTO(row!).id).toBe(row!.id);
  });

  it('orders oldest first and scopes to the owner', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    const first = await insertPasskey(mine.id, { name: 'First' });
    await adminDb.passkey.update({
      where: { id: first.id },
      data: { createdAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    await insertPasskey(mine.id, { name: 'Second' });
    await insertPasskey(theirs.id, { name: 'Theirs' });

    expect((await passkeyService.listForUser(mine.id)).map((p) => p.name)).toEqual([
      'First',
      'Second',
    ]);
    expect(await passkeyService.countForUser(mine.id)).toBe(2);
    expect(await passkeyService.countForUser(theirs.id)).toBe(1);
  });

  it('keeps an unnamed row unnamed rather than defaulting it server-side', async () => {
    const user = await makeUser();
    await insertPasskey(user.id, { name: null });

    const [dto] = await passkeyService.listForUser(user.id);

    // The pane owns the fallback label. A server-side default would make an
    // unnamed row indistinguishable from one somebody deliberately named.
    expect(dto?.name).toBeNull();
  });
});

describe('the method set — the value Story 8.13 will read', () => {
  it('reports `passkey` with two-factor OFF', async () => {
    // THE row this story exists for. The passkey plugin never touches
    // `user.twoFactorEnabled`, so this account is genuinely multi-factor
    // (user verification is required) while that flag is down.
    const user = await makeUser(false);
    await insertPasskey(user.id);

    const status = await twoFactorService.getStatus(user.id);

    expect(status.enabled).toBe(false);
    expect(status.methods).toEqual(['passkey']);
    expect(status.primaryMethod).toBeNull();
    // The contract, stated as 8.13 will read it.
    expect(status.methods.length > 0).toBe(true);
  });

  it('withholds `totp` while the enrolment is UNVERIFIED, and still reports the passkey', async () => {
    const user = await makeUser(true);
    await insertTwoFactor(user.id, false);
    await insertPasskey(user.id);

    const status = await twoFactorService.getStatus(user.id);

    expect(status.methods).toEqual(['email', 'passkey']);
    expect(status.primaryMethod).toBe('email');
  });

  it('reports all three once the authenticator is confirmed', async () => {
    const user = await makeUser(true);
    await insertTwoFactor(user.id, true);
    await insertPasskey(user.id);

    const status = await twoFactorService.getStatus(user.id);

    expect(status.methods).toEqual(['totp', 'email', 'passkey']);
    expect(status.primaryMethod).toBe('totp');
  });

  it('reproduces the pre-passkey answer exactly for an account with none', async () => {
    const off = await makeUser(false);
    expect(await twoFactorService.getStatus(off.id)).toMatchObject({
      enabled: false,
      methods: [],
      primaryMethod: null,
    });

    const on = await makeUser(true);
    await insertTwoFactor(on.id, true);
    expect(await twoFactorService.getStatus(on.id)).toMatchObject({
      enabled: true,
      methods: ['totp', 'email'],
      primaryMethod: 'totp',
    });
  });

  it('NEVER answers `passkey` as `primaryMethod`, over every real combination', async () => {
    // Exhaustive against the database rather than against the mapper's
    // arguments: `getStatus` composes three reads, and the regression that would
    // reintroduce `methods[0]` lives between them.
    for (const enabled of [false, true]) {
      for (const enrolment of [null, true, false]) {
        for (const passkeys of [0, 2]) {
          const user = await makeUser(enabled);
          if (enrolment !== null) await insertTwoFactor(user.id, enrolment);
          for (let i = 0; i < passkeys; i += 1) await insertPasskey(user.id);

          const status = await twoFactorService.getStatus(user.id);

          expect(status.primaryMethod).not.toBe('passkey');
          expect(status.methods.includes('passkey')).toBe(passkeys > 0);
        }
      }
    }
  });
});

describe('the cascade is a claim about the DATABASE', () => {
  it('deletes a user’s passkeys with the user, against the real foreign key', async () => {
    // `onDelete: Cascade` in `schema.prisma` is a claim until a row proves it:
    // the constraint lives in the migration, and a schema that says one thing
    // over a database that says another is the drift class CLAUDE.md's
    // FK-`@relation` rule exists for.
    const user = await makeUser();
    await insertPasskey(user.id);
    await insertPasskey(user.id);
    expect(await adminDb.passkey.count({ where: { userId: user.id } })).toBe(2);

    await adminDb.user.delete({ where: { id: user.id } });

    expect(await adminDb.passkey.count({ where: { userId: user.id } })).toBe(0);
  });

  it('lets one user hold several — the shape the feature is FOR', async () => {
    // Unlike `two_factor`, where several rows are a lost race, several rows here
    // are the point: a laptop, a phone and a hardware key.
    const user = await makeUser();
    await insertPasskey(user.id, { name: 'Laptop' });
    await insertPasskey(user.id, { name: 'Phone' });
    await insertPasskey(user.id, { name: 'Key' });

    expect(await passkeyService.countForUser(user.id)).toBe(3);
  });
});
