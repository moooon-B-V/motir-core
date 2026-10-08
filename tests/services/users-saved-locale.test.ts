import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { usersService } from '@/lib/services/usersService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7730 · MOTIR-7743 — the saved language is read BY USER ID with no
// request in scope, against real Postgres.

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

describe('usersService.getSavedLocale', () => {
  it('returns a saved locale', async () => {
    const id = await userWithLocale('zh@example.com', 'zh');
    expect(await usersService.getSavedLocale(id)).toBe('zh');
  });

  it('returns null when nothing is saved', async () => {
    const id = await userWithLocale('none@example.com', null);
    expect(await usersService.getSavedLocale(id)).toBeNull();
  });

  it('returns null for a stored value that is not a locale', async () => {
    const id = await userWithLocale('xx@example.com', 'xx');
    expect(await usersService.getSavedLocale(id)).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    expect(await usersService.getSavedLocale('no-such-user')).toBeNull();
  });
});
