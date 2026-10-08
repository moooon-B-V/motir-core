import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTranslator } from 'next-intl';

// Story MOTIR-7730 · MOTIR-7760 — the story integration gate for the language
// seam, end to end below the browser.
//
// Every predecessor tested its own piece against a stand-in for its neighbour:
// the resolution against a mocked session user, the seed against a hand-built
// hook context, the action against a session object. What none of them proves
// is the ASSEMBLED seam: a real `user` row in Postgres, read through the REAL
// session (a cookie a real sign-in issued, validated by Better-Auth against the
// `session` table), deciding a real request's language ahead of its cookie and
// its browser — and a real sign-up writing that row.
//
// ── What is substituted, and why none of it is under test ────────────────────
//
// NOTHING in `@/lib/auth` is mocked, `getSession()` included: it runs for real
// and reads the session cookie off the request headers this file builds. Two
// ENVIRONMENT shims stand in for the Next.js request scope, which Vitest does
// not have — the same substitution `tests/auth/sessionRenderProbe.ts` argues for
// (rebuilding Next's private async-storage stack would rot on the next upgrade):
//
//   * `next/headers` — `headers()` returns the request's own `Headers`;
//     `cookies()` reads that request's `Cookie` header and records what a
//     response would set. It is the request, not a stand-in for any logic.
//   * `next-intl/server` — Vitest resolves next-intl's CLIENT build, whose
//     `getRequestConfig` refuses to run. The stub is next-intl's own
//     `react-server` implementation, loaded from the package (an identity).
//
// The database, Better-Auth, the hooks, the services and the catalogues are all
// the real ones.

vi.hoisted(() => {
  // The catch-all route's shared limiter (`lib/rateLimit/limiter.ts`) — the
  // same switch `tests/integration/auth/signInPathsOnUpgrade.test.ts` sets.
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const request = vi.hoisted(() => ({
  headers: new Headers(),
  set: new Map<string, string>(),
}));

function requestCookie(name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) => {
      const value = requestCookie(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      request.set.set(name, value);
    },
  }),
}));

vi.mock('next-intl/server', async () => {
  const { default: getRequestConfig } = await import(
    /* @vite-ignore */ pathToFileURL(
      resolve(
        process.cwd(),
        'node_modules/next-intl/dist/esm/development/server/react-server/getRequestConfig.js',
      ),
    ).href
  );
  return { getRequestConfig };
});

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const authRoute = await import('@/app/api/auth/[...all]/route');
const { default: requestConfig } = await import('@/i18n/request');
const { setLocale } = await import('@/lib/i18n/actions');
const { getMessagesFor, withEnglishFallback } = await import('@/lib/i18n/messages');
const { locales } = await import('@/lib/i18n/locales');
const { default: en } = await import('@/messages/en.json');
const { default: ja } = await import('@/messages/ja.json');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');

// Better-Auth's endpoint-context store. `runWithEndpointContext` is what its own
// dispatcher wraps every endpoint in (`better-auth/dist/api/dispatch.mjs`); the
// store lives on a process global, so this copy shares it with the hooks.
// Resolved through `better-auth` because `@better-auth/core` is its dependency,
// not this repository's.
const { runWithEndpointContext } = (await import(
  /* @vite-ignore */ pathToFileURL(
    createRequire(createRequire(import.meta.url).resolve('better-auth')).resolve(
      '@better-auth/core/context',
    ),
  ).href
)) as {
  runWithEndpointContext: <T>(ctx: unknown, fn: () => Promise<T>) => Promise<T>;
};

const BASE = 'http://localhost:3000';
const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
  request.headers = new Headers();
  request.set = new Map();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Drivers ──────────────────────────────────────────────────────────────────

/** A real email sign-up, carrying the signing-up request's own headers. */
async function signUp(email: string, headers: Record<string, string> = {}) {
  await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: 'Lang' },
    headers: { origin: BASE, ...headers },
  });
  return (await adminDb.user.findUniqueOrThrow({ where: { email } })).locale;
}

/** A real sign-in through the catch-all route the browser posts to. */
async function signIn(email: string, cookie?: string): Promise<Response> {
  const res = await authRoute.POST(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return res;
}

/** The `name=value` pairs a response sets, as the next request's Cookie header. */
function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** An account with a saved language and a signed-in browser for it. */
async function signedInAccount(email: string, saved: string | null): Promise<string> {
  await signUp(email);
  await adminDb.user.update({ where: { email }, data: { locale: saved } });
  const sessionCookie = cookiesOf(await signIn(email));
  expect(sessionCookie).toContain('session_token');
  // Only the session: the NEXT_LOCALE the sign-in sync may set is not carried,
  // so each case states its browser choice itself.
  return sessionCookie
    .split('; ')
    .filter((c) => !c.startsWith('NEXT_LOCALE='))
    .join('; ');
}

/** Build THE request: its Cookie header and its Accept-Language. */
function onRequest({
  session,
  nextLocale,
  acceptLanguage,
}: {
  session?: string;
  nextLocale?: string;
  acceptLanguage?: string;
}) {
  const cookie = [session, nextLocale === undefined ? undefined : `NEXT_LOCALE=${nextLocale}`]
    .filter(Boolean)
    .join('; ');
  request.headers = new Headers({
    ...(cookie ? { cookie } : {}),
    ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
  });
  request.set = new Map();
}

/** The request config's resolution — what every render of that request reads. */
async function resolvedLocale(): Promise<string> {
  const config = await (requestConfig as unknown as (p: unknown) => Promise<{ locale: string }>)({
    requestLocale: Promise.resolve(undefined),
  });
  return config.locale;
}

// ── The resolution order ─────────────────────────────────────────────────────

describe('the resolution order, against a real account row and a real session', () => {
  it('a saved account language beats the cookie and the browser', async () => {
    const session = await signedInAccount('ja@example.com', 'ja');
    onRequest({ session, nextLocale: 'de', acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('ja');
  });

  it('with nothing saved, the cookie comes second', async () => {
    const session = await signedInAccount('none@example.com', null);
    onRequest({ session, nextLocale: 'de', acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('de');
  });

  it('with no cookie, the best browser match comes third', async () => {
    const session = await signedInAccount('browser@example.com', null);
    onRequest({ session, acceptLanguage: 'fr-CA,fr;q=0.9,en;q=0.8' });
    expect(await resolvedLocale()).toBe('fr');
  });

  it('a region subtag matches its base language', async () => {
    const session = await signedInAccount('region@example.com', null);
    onRequest({ session, acceptLanguage: 'pt-BR' });
    expect(await resolvedLocale()).toBe('pt');
    onRequest({ session, acceptLanguage: 'ko-KR' });
    expect(await resolvedLocale()).toBe('ko');
  });

  it('nothing supported falls to English', async () => {
    const session = await signedInAccount('rtl@example.com', null);
    onRequest({ session, acceptLanguage: 'ar,he' });
    expect(await resolvedLocale()).toBe('en');
  });

  it('an invalid cookie falls through and does not win', async () => {
    const session = await signedInAccount('bad-cookie@example.com', null);
    onRequest({ session, nextLocale: 'xx', acceptLanguage: 'it' });
    expect(await resolvedLocale()).toBe('it');
  });

  it('signed out, the same order runs from step 2', async () => {
    onRequest({ nextLocale: 'de', acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('de');
    onRequest({ acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('fr');
  });

  it('the language is the ROW’s: an update between two requests is read on the second', async () => {
    // The boundary (`lib/auth/index.ts`, the `getSession` comment): the session
    // is re-read per request — `getSession` is memoised only per RENDER by
    // React `cache()`, and Better-Auth's `session.cookieCache` is OFF — so the
    // saved language carried on the session is the row's as of that request.
    const session = await signedInAccount('reread@example.com', 'ja');
    onRequest({ session, nextLocale: 'de', acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('ja');

    await adminDb.user.update({ where: { email: 'reread@example.com' }, data: { locale: 'nl' } });

    onRequest({ session, nextLocale: 'de', acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('nl');
  });
});

// ── The sign-up seed ─────────────────────────────────────────────────────────

describe('the sign-up seed writes the row', () => {
  it('from the browser’s NEXT_LOCALE choice', async () => {
    expect(await signUp('ko@example.com', { cookie: 'NEXT_LOCALE=ko' })).toBe('ko');
  });

  it('from the best Accept-Language match when no choice was made', async () => {
    expect(await signUp('de@example.com', { 'accept-language': 'de-DE' })).toBe('de');
  });

  it('English when nothing the browser asks for is supported', async () => {
    expect(await signUp('ar@example.com', { 'accept-language': 'ar' })).toBe('en');
  });

  it('a Google new user is seeded through the same user-create hook', async () => {
    // The Google callback, once Google has answered, reaches
    // `handleOAuthUserInfo` (`better-auth/dist/oauth2/link-account.mjs`), which
    // creates a NEW user with `internalAdapter.createUser(…, { method: 'oauth' })`
    // inside its endpoint context. That is driven here for real — Better-Auth's
    // hooked adapter, `databaseHooks.user.create.before`, a real insert — inside
    // an endpoint context carrying the callback's request headers. Google's
    // round trip itself (state, token exchange) needs Google, so it is the story
    // E2E's; the endpoint context's SHAPE is the one part built by hand here.
    const authContext = await auth.$context;
    const headers = new Headers({ cookie: 'NEXT_LOCALE=ja', 'accept-language': 'de-DE' });
    const created = await runWithEndpointContext(
      {
        path: '/callback/:id',
        params: { id: 'google' },
        headers,
        request: new Request(`${BASE}/api/auth/callback/google`, { headers }),
        context: authContext,
      },
      () =>
        authContext.internalAdapter.createUser(
          { email: 'Georgia@Example.com', name: 'Georgia', emailVerified: true },
          { method: 'oauth', oauth: { providerId: 'google' } } as never,
        ),
    );
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.email).toBe('georgia@example.com');
    expect(row.locale).toBe('ja');
  });

  it('a create with no request in scope saves nothing rather than guessing', async () => {
    // The control for the case above: the same create OUTSIDE an endpoint
    // context — a seed script — leaves the column null. So the `ja` above came
    // from the callback's request, not from a default.
    const authContext = await auth.$context;
    const created = await authContext.internalAdapter.createUser(
      { email: 'script@example.com', name: 'Script', emailVerified: true },
      { method: 'oauth', oauth: { providerId: 'google' } } as never,
    );
    expect((await adminDb.user.findUniqueOrThrow({ where: { id: created.id } })).locale).toBeNull();
  });

  it('sign-in never overwrites the account: it aligns the browser to it', async () => {
    await signUp('saved@example.com');
    await adminDb.user.update({ where: { email: 'saved@example.com' }, data: { locale: 'ja' } });

    const res = await signIn('saved@example.com', 'NEXT_LOCALE=de');

    const row = await adminDb.user.findUniqueOrThrow({ where: { email: 'saved@example.com' } });
    expect(row.locale).toBe('ja');
    const set = res.headers.getSetCookie().filter((c) => c.startsWith('NEXT_LOCALE='));
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^NEXT_LOCALE=ja;/);
  });
});

// ── Writing the choice ───────────────────────────────────────────────────────

describe('writing the choice with setLocale', () => {
  it('signed in: the account row and the cookie both say pl', async () => {
    const session = await signedInAccount('choose@example.com', 'en');
    onRequest({ session });
    await setLocale('pl');
    expect(
      (await adminDb.user.findUniqueOrThrow({ where: { email: 'choose@example.com' } })).locale,
    ).toBe('pl');
    expect(request.set.get('NEXT_LOCALE')).toBe('pl');

    // And the next request of that browser resolves to it.
    onRequest({ session, nextLocale: 'pl', acceptLanguage: 'fr' });
    expect(await resolvedLocale()).toBe('pl');
  });

  it('signed out: the cookie is es and no user row changes', async () => {
    await signUp('one@example.com', { 'accept-language': 'de' });
    await signUp('two@example.com', { 'accept-language': 'it' });
    const snapshot = async () =>
      (
        await adminDb.user.findMany({
          select: { id: true, locale: true, updatedAt: true },
          orderBy: { id: 'asc' },
        })
      ).map((u) => ({ ...u, updatedAt: u.updatedAt.toISOString() }));
    const before = await snapshot();
    expect(before).toHaveLength(2);

    onRequest({ acceptLanguage: 'fr' });
    await setLocale('es');

    expect(request.set.get('NEXT_LOCALE')).toBe('es');
    expect(await snapshot()).toEqual(before);
  });
});

// ── The English fallback, through the real message loader ────────────────────

describe('the English fallback', () => {
  const KEY = 'common.retry';

  it('a key a catalogue lacks resolves to the English string, never the key path', () => {
    // A temporary in-memory copy; the committed catalogue is never touched.
    const copy = structuredClone(ja) as typeof ja;
    expect((copy.common as Record<string, unknown>)['retry']).toBeDefined();
    expect(copy.common.retry).not.toBe(en.common.retry);
    delete (copy.common as Record<string, unknown>)['retry'];

    const silent = { onError: () => {} };
    // The control: without the fallback, next-intl renders the raw key path.
    const bare = createTranslator({ locale: 'ja', messages: copy, ...silent });
    expect(bare(KEY as never)).toBe(KEY);

    const t = createTranslator({
      locale: 'ja',
      messages: withEnglishFallback(copy, en),
      ...silent,
    });
    expect(t(KEY as never)).toBe(en.common.retry);
    // A key the copy still has keeps its translation.
    expect(t('common.cancel' as never)).toBe(ja.common.cancel);
  });

  it('the loader answers every English key in every locale', () => {
    const flatKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null
          ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      );
    const enKeys = flatKeys(en);
    for (const locale of locales) {
      const loaded = new Set(flatKeys(getMessagesFor(locale)));
      const missing = enKeys.filter((k) => !loaded.has(k));
      expect(missing, locale).toEqual([]);
    }
    // The committed Japanese string, through the loader, is the Japanese one.
    expect(createTranslator({ locale: 'ja', messages: getMessagesFor('ja') })(KEY as never)).toBe(
      ja.common.retry,
    );
  });
});
