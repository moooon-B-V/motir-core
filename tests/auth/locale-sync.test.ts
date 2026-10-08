import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auth } from '@/lib/auth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7730 · MOTIR-7747 — sign-in brings the browser's NEXT_LOCALE in
// line with the saved account language, read off the real Set-Cookie.

const BASE_URL = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function account(email: string, locale: string | null) {
  await auth.api.signUpEmail({
    body: { email, password: 'hunter2hunter2', name: 'Sync' },
    headers: { origin: BASE_URL },
  });
  await adminDb.user.update({ where: { email }, data: { locale } });
}

async function signInCookies(email: string, cookie?: string): Promise<string[]> {
  const res = await auth.api.signInEmail({
    body: { email, password: 'hunter2hunter2' },
    headers: { origin: BASE_URL, ...(cookie ? { cookie } : {}) },
    asResponse: true,
  });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().filter((c) => c.startsWith('NEXT_LOCALE='));
}

describe('sign-in syncs NEXT_LOCALE to the saved language', () => {
  it('sets it, with Path=/ and SameSite=Lax, when the browser disagrees', async () => {
    await account('en@example.com', 'en');
    const set = await signInCookies('en@example.com', 'NEXT_LOCALE=zh');
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^NEXT_LOCALE=en;/);
    expect(set[0]).toMatch(/Path=\//);
    expect(set[0]).toMatch(/SameSite=Lax/i);
    expect((await adminDb.user.findUnique({ where: { email: 'en@example.com' } }))!.locale).toBe(
      'en',
    );
  });

  it('sets nothing when nothing is saved', async () => {
    await account('none@example.com', null);
    expect(await signInCookies('none@example.com', 'NEXT_LOCALE=zh')).toEqual([]);
  });

  it('sets nothing when the browser already agrees', async () => {
    await account('zh@example.com', 'zh');
    expect(await signInCookies('zh@example.com', 'NEXT_LOCALE=zh')).toEqual([]);
  });
});
