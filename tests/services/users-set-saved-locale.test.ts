import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { usersService } from '@/lib/services/usersService';
import type { Locale } from '@/lib/i18n/locales';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7730 · MOTIR-7747 — saving the account language, real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function user(locale: string | null): Promise<string> {
  return (await adminDb.user.create({ data: { email: 'a@example.com', name: 'A', locale } })).id;
}

const stored = async (id: string) => (await adminDb.user.findUnique({ where: { id } }))?.locale;

describe('usersService.setSavedLocale', () => {
  it('saves a language on an account with none', async () => {
    const id = await user(null);
    await usersService.setSavedLocale(id, 'zh');
    expect(await stored(id)).toBe('zh');
  });

  it('replaces a saved language — last writer wins', async () => {
    const id = await user('zh');
    await usersService.setSavedLocale(id, 'en');
    expect(await stored(id)).toBe('en');
  });

  it('writes nothing for a value outside the locale set', async () => {
    const id = await user('en');
    await usersService.setSavedLocale(id, 'xx' as Locale);
    expect(await stored(id)).toBe('en');
  });
});
