import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AppSession } from '@/lib/auth';

// Story MOTIR-7730 · MOTIR-7743 — the request config resolves every request by
// the four steps, and a failing session read degrades to steps 2–4 instead of
// failing the page. `getSession` is the one allowed mock; `next/headers` is
// stubbed because the Vitest environment has no request scope.

const state: {
  session: unknown;
  sessionThrows: Error | null;
  cookie: string | undefined;
  acceptLanguage: string | null;
} = { session: null, sessionThrows: null, cookie: undefined, acceptLanguage: null };

class FakeSessionUnavailableError extends Error {}

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => {
    if (state.sessionThrows) throw state.sessionThrows;
    return state.session;
  }),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === 'NEXT_LOCALE' && state.cookie !== undefined ? { value: state.cookie } : undefined,
  })),
  headers: vi.fn(async () => {
    const h = new Headers();
    if (state.acceptLanguage !== null) h.set('accept-language', state.acceptLanguage);
    return h;
  }),
}));

// Under Vitest, next-intl resolves its react-client build, whose
// `getRequestConfig` refuses to run. Its server build returns the callback it is
// given unchanged, so the stub does exactly that; the callback receives
// next-intl's own params, which this config does not read.
vi.mock('next-intl/server', () => ({
  getRequestConfig: (fn: unknown) => fn,
}));

// A Japanese catalogue holding ONE key, so every other key is absent from it —
// the request's messages must still carry it, in English (MOTIR-7757).
vi.mock('@/messages/ja.json', () => ({ default: { common: { retry: '再試行' } } }));

const { default: requestConfig } = await import('@/i18n/request');
const { default: en } = await import('@/messages/en.json');
async function resolve() {
  const config = await (
    requestConfig as unknown as (p: unknown) => Promise<Record<string, unknown>>
  )({ requestLocale: Promise.resolve(undefined) });
  return config;
}

beforeEach(() => {
  state.session = null;
  state.sessionThrows = null;
  state.cookie = undefined;
  state.acceptLanguage = null;
});

describe('i18n request config', () => {
  it('signed out with no cookie follows the browser', async () => {
    state.acceptLanguage = 'zh-TW,zh;q=0.9,en;q=0.5';
    expect((await resolve())['locale']).toBe('zh');
    state.acceptLanguage = 'sv-SE,sv;q=0.9';
    expect((await resolve())['locale']).toBe('en');
  });

  it('signed out: the choice beats the browser, and an invalid choice is skipped', async () => {
    state.cookie = 'en';
    state.acceptLanguage = 'zh';
    expect((await resolve())['locale']).toBe('en');
    state.cookie = 'xx';
    expect((await resolve())['locale']).toBe('zh');
  });

  it('signed in: the saved language wins', async () => {
    state.session = { user: { id: 'u1', locale: 'zh' }, session: {} };
    state.cookie = 'en';
    state.acceptLanguage = 'en-US';
    expect((await resolve())['locale']).toBe('zh');
  });

  it('signed in with nothing saved, or an invalid saved value, falls through', async () => {
    state.session = { user: { id: 'u1', locale: null }, session: {} };
    state.cookie = 'zh';
    expect((await resolve())['locale']).toBe('zh');
    state.session = { user: { id: 'u1', locale: 'xx' }, session: {} };
    state.cookie = undefined;
    state.acceptLanguage = 'zh';
    expect((await resolve())['locale']).toBe('zh');
    state.acceptLanguage = null;
    expect((await resolve())['locale']).toBe('en');
  });

  it('a session read that throws resolves by steps 2–4 and does not throw', async () => {
    state.sessionThrows = new FakeSessionUnavailableError('db down');
    state.acceptLanguage = 'zh';
    await expect(resolve()).resolves.toMatchObject({ locale: 'zh' });
  });

  it('keeps the shared `now`, the UTC time zone and the locale catalogue', async () => {
    const config = await resolve();
    expect(config['timeZone']).toBe('UTC');
    expect(config['now']).toBeInstanceOf(Date);
    const messages = config['messages'] as Record<string, unknown>;
    expect(messages).toHaveProperty('common');
  });

  it('fills a key the locale lacks from English, and keeps the translated ones', async () => {
    state.cookie = 'ja';
    const config = await resolve();
    expect(config['locale']).toBe('ja');
    const messages = config['messages'] as typeof en;
    expect(messages.common.retry).toBe('再試行');
    expect(messages.errors.serverError.appTitle).toBe(en.errors.serverError.appTitle);
  });

  it('the session carries `locale`, typed', () => {
    // A Better-Auth additional field joins the inferred session user type. The
    // `input: false` half (no sign-up / update-user body can set it) is asserted
    // against the options in `tests/auth/user-locale-field.test.ts`.
    expectTypeOf<AppSession['user']>().toHaveProperty('locale');
  });
});
