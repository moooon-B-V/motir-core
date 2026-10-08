import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@/lib/i18n/locales';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-7730 · MOTIR-7747 — the Settings choice saves on the account
// FIRST, then on the browser; signed out it is the cookie alone. Real Postgres;
// the session (and the request's cookie jar, which needs a request) are mocked.

const events: string[] = [];
const jar = new Map<string, { value: string; options: unknown }>();
const session = vi.hoisted(() => ({ current: null as unknown, throws: null as unknown }));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    set: (name: string, value: string, options: unknown) => {
      events.push(`cookie:${value}`);
      jar.set(name, { value, options });
    },
  })),
}));

vi.mock('@/lib/auth', async () => {
  class SessionUnavailableError extends Error {}
  return {
    SessionUnavailableError,
    getSession: vi.fn(async () => {
      if (session.throws === 'unavailable') throw new SessionUnavailableError('down');
      return session.current;
    }),
  };
});

const { setLocale } = await import('@/lib/i18n/actions');
const { usersService } = await import('@/lib/services/usersService');

let userId = '';

beforeEach(async () => {
  await truncateAuthTables();
  events.length = 0;
  jar.clear();
  session.throws = null;
  userId = (
    await adminDb.user.create({ data: { email: 'a@example.com', name: 'A', locale: null } })
  ).id;
  session.current = { user: { id: userId } };
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
});

const stored = async () => (await adminDb.user.findUnique({ where: { id: userId } }))?.locale;

describe('setLocale', () => {
  it('signed in: saves on the account, then sets the cookie with the shared attributes', async () => {
    const real = usersService.setSavedLocale.bind(usersService);
    vi.spyOn(usersService, 'setSavedLocale').mockImplementation(async (id, l) => {
      await real(id, l);
      events.push(`account:${l}`);
    });
    await setLocale('zh');
    expect(await stored()).toBe('zh');
    expect(events).toEqual(['account:zh', 'cookie:zh']);
    expect(jar.get('NEXT_LOCALE')).toEqual({
      value: 'zh',
      options: { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' },
    });
  });

  it('a failed account write rejects and sets no cookie', async () => {
    vi.spyOn(usersService, 'setSavedLocale').mockRejectedValue(new Error('db down'));
    await expect(setLocale('zh')).rejects.toThrow('db down');
    expect(jar.has('NEXT_LOCALE')).toBe(false);
  });

  it('signed out: the cookie only, no row written', async () => {
    session.current = null;
    await setLocale('zh');
    expect(jar.get('NEXT_LOCALE')?.value).toBe('zh');
    expect(await stored()).toBeNull();
  });

  it('session unavailable: treated as signed out', async () => {
    session.throws = 'unavailable';
    await setLocale('zh');
    expect(jar.get('NEXT_LOCALE')?.value).toBe('zh');
    expect(await stored()).toBeNull();
  });

  it('a staff "View as" session does not change the viewed account', async () => {
    session.current = { user: { id: userId }, impersonation: { operator: 'x' } };
    await setLocale('zh');
    expect(await stored()).toBeNull();
    expect(jar.get('NEXT_LOCALE')?.value).toBe('zh');
  });

  it('an invalid value writes neither', async () => {
    await setLocale('xx' as Locale);
    expect(jar.size).toBe(0);
    expect(await stored()).toBeNull();
  });
});
