import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, authOptions } from '@/lib/auth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7730 · MOTIR-7747 — sign-up seeds the account language in the
// user insert, from the signing-up request; nothing else ever writes it.

const BASE_URL = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

async function signUp(email: string, headers: Record<string, string>) {
  await auth.api.signUpEmail({
    body: { email, password: 'hunter2hunter2', name: 'Seed' },
    headers: { origin: BASE_URL, ...headers },
  });
  return (await adminDb.user.findUnique({ where: { email } }))!;
}

type CreateBefore = (
  user: Record<string, unknown>,
  ctx: unknown,
) => Promise<{ data: Record<string, unknown> }>;
const createBefore = authOptions.databaseHooks!.user!.create!.before as unknown as CreateBefore;

describe('sign-up seeds the account language', () => {
  it('from the browser when no choice was made', async () => {
    expect((await signUp('zh@example.com', { 'accept-language': 'zh-CN,zh;q=0.9' })).locale).toBe(
      'zh',
    );
    expect((await signUp('sv@example.com', { 'accept-language': 'sv-SE' })).locale).toBe('en');
  });

  it('from the browser’s choice over its Accept-Language', async () => {
    const u = await signUp('choice@example.com', {
      cookie: 'NEXT_LOCALE=zh',
      'accept-language': 'en-US',
    });
    expect(u.locale).toBe('zh');
  });

  it('skipping an invalid choice', async () => {
    const u = await signUp('bad@example.com', {
      cookie: 'NEXT_LOCALE=xx',
      'accept-language': 'zh',
    });
    expect(u.locale).toBe('zh');
  });

  it('on the Google path: the hook reads ctx.headers from an OAuth-callback-shaped context', async () => {
    const ctx = {
      path: '/callback/:id',
      headers: new Headers({ cookie: 'NEXT_LOCALE=zh', 'accept-language': 'en' }),
      request: new Request(`${BASE_URL}/api/auth/callback/google`),
    };
    const out = await createBefore({ email: 'g@example.com', name: 'G' }, ctx);
    expect(out.data.locale).toBe('zh');
    expect(out.data.email).toBe('g@example.com');
  });

  it('and from ctx.request.headers when that is all the context carries', async () => {
    const ctx = { request: new Request(BASE_URL, { headers: { 'accept-language': 'zh' } }) };
    expect((await createBefore({ email: 'r@example.com' }, ctx)).data.locale).toBe('zh');
  });

  it('saves nothing with no request in scope', async () => {
    expect((await createBefore({ email: 'seed@example.com' }, null)).data.locale).toBeNull();
  });
});

describe('sign-in never overwrites the saved language', () => {
  it('leaves an existing account’s language as it was', async () => {
    await signUp('en@example.com', { 'accept-language': 'en' });
    await auth.api.signInEmail({
      body: { email: 'en@example.com', password: 'hunter2hunter2' },
      headers: { origin: BASE_URL, cookie: 'NEXT_LOCALE=zh', 'accept-language': 'zh' },
    });
    expect((await adminDb.user.findUnique({ where: { email: 'en@example.com' } }))!.locale).toBe(
      'en',
    );
  });
});
