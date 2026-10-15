import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveRecipientLocale,
  resolveRecipientLocales,
} from '@/lib/services/emailRecipientLocale';
import { adminDb } from '../helpers/adminDb';
import { countDelegateCalls } from '../helpers/countDelegateCalls';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7732 · MOTIR-8104 — an email is written in its RECIPIENT's
// language, resolved with no request in scope, against real Postgres.

async function userWithLocale(email: string, locale: string | null): Promise<string> {
  const row = await adminDb.user.create({ data: { email, name: email, locale } });
  return row.id;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('resolveRecipientLocale', () => {
  it('reads a user id’s saved language', async () => {
    const id = await userWithLocale('ko@example.com', 'ko');
    expect(await resolveRecipientLocale({ userId: id })).toBe('ko');
  });

  it('resolves English for a user id with nothing saved, or no such user', async () => {
    const id = await userWithLocale('none@example.com', null);
    expect(await resolveRecipientLocale({ userId: id })).toBe('en');
    expect(await resolveRecipientLocale({ userId: 'no-such-user' })).toBe('en');
  });

  it('reads the account an address belongs to, whatever the address’s case', async () => {
    await userWithLocale('nl@example.com', 'nl');
    expect(await resolveRecipientLocale({ email: 'NL@Example.COM' })).toBe('nl');
  });

  it('resolves English for an address with no account and nothing recorded', async () => {
    expect(await resolveRecipientLocale({ email: 'stranger@example.com' })).toBe('en');
  });

  it('uses the recorded language for an address with no account', async () => {
    expect(
      await resolveRecipientLocale({ email: 'follower@example.com', recordedLocale: 'it' }),
    ).toBe('it');
  });

  it('prefers the account’s saved language over the recorded one', async () => {
    await userWithLocale('de@example.com', 'de');
    expect(await resolveRecipientLocale({ email: 'de@example.com', recordedLocale: 'it' })).toBe(
      'de',
    );
  });

  it('resolves English, not the recorded language, for an account with nothing saved', async () => {
    await userWithLocale('plain@example.com', null);
    expect(await resolveRecipientLocale({ email: 'plain@example.com', recordedLocale: 'it' })).toBe(
      'en',
    );
  });

  it('falls through from a user id with nothing saved to the address', async () => {
    const id = await userWithLocale('blank@example.com', null);
    expect(
      await resolveRecipientLocale({
        userId: id,
        email: 'blank@example.com',
        recordedLocale: 'it',
      }),
    ).toBe('en');
    expect(
      await resolveRecipientLocale({
        userId: 'no-such-user',
        email: 'nobody@example.com',
        recordedLocale: 'fr',
      }),
    ).toBe('fr');
  });

  it.each(['xx', '', null])('resolves English for a recorded value of %j', async (recorded) => {
    expect(
      await resolveRecipientLocale({ email: 'stranger@example.com', recordedLocale: recorded }),
    ).toBe('en');
  });
});

describe('resolveRecipientLocales', () => {
  it('answers every requested id, English where nothing valid is saved', async () => {
    const zh = await userWithLocale('zh@example.com', 'zh');
    const none = await userWithLocale('none@example.com', null);
    const bad = await userWithLocale('bad@example.com', 'xx');
    const answer = await resolveRecipientLocales([zh, none, bad, 'no-such-user', zh]);
    expect(Object.fromEntries(answer)).toEqual({
      [zh]: 'zh',
      [none]: 'en',
      [bad]: 'en',
      'no-such-user': 'en',
    });
  });

  it('makes one user query for one recipient and for five', async () => {
    const ids = await Promise.all(
      ['es', 'fr', 'pt', 'ja', 'pl'].map((l) => userWithLocale(`${l}@example.com`, l)),
    );
    const one = await countDelegateCalls('user', 'findMany', () =>
      resolveRecipientLocales(ids.slice(0, 1)),
    );
    const five = await countDelegateCalls('user', 'findMany', () => resolveRecipientLocales(ids));
    expect(one.queries).toBe(1);
    expect(five.queries).toBe(1);
    expect([...five.result.values()]).toEqual(['es', 'fr', 'pt', 'ja', 'pl']);
  });
});
