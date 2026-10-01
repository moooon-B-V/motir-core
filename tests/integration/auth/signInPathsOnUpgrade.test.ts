import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Story MOTIR-7170 · Subtask MOTIR-7175 — the sign-in paths on the upgraded
// library (better-auth 1.7.7), each through its REAL route.
//
// The 1.7 upgrade's units mock their neighbours; these drive the catch-all auth
// route the browser hits. Two of the five paths have story-level seams of their
// own that already drive the real endpoints on this branch, and are not
// duplicated here:
//
//   * two-factor enrol and challenge — `tests/integration/twoFactorSeam.test.ts`
//   * passkey sign-in — `tests/integration/passkeySeam.test.ts`
//   * `motir login` — `tests/cli/cli-device-routes.test.ts` (`/api/cli/device/*`)
//
// Google's full round trip needs a browser and Google's stub server, so its
// callback is the E2E's (`tests/e2e/auth-google.spec.ts`); here it is the leg
// Motir owns — the route answering with Google's authorize URL for THIS app.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');
const { createTestUser, TEST_PASSWORD } = await import('../../fixtures/userFixtures');
const authRoute = await import('@/app/api/auth/[...all]/route');
const { BASE } = await import('../../helpers/oauthFlow');

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return authRoute.POST(
    new Request(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('the library under test', () => {
  it('every better-auth package is on 1.7.7', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const pinned = Object.entries(pkg.dependencies).filter(
      ([name]) => name === 'better-auth' || name.startsWith('@better-auth/'),
    );
    expect(pinned.length).toBeGreaterThan(1);
    for (const [name, version] of pinned) expect(`${name}@${version}`).toBe(`${name}@1.7.7`);
  });
});

describe('email and password', () => {
  it('signs in through the route, and the session it sets is read back', async () => {
    const user = await createTestUser();
    const res = await post('/sign-in/email', { email: user.email, password: TEST_PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toContain('session_token');

    const session = await authRoute.GET(
      new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }),
    );
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(user.id);
  });

  it('refuses a wrong password, and sets no session', async () => {
    const user = await createTestUser();
    const res = await post('/sign-in/email', { email: user.email, password: 'not-the-password' });
    expect(res.status).toBe(401);
    expect(cookieOf(res)).not.toContain('session_token');
  });

  it('a credential account is found by its user — the 1.7 accountId backfill holds', async () => {
    const user = await createTestUser();
    const account = await adminDb.account.findFirstOrThrow({
      where: { userId: user.id, providerId: 'credential' },
    });
    expect(account.accountId).toBe(user.id);
  });
});

describe('Google', () => {
  it('the route answers with Google’s authorize URL for this app, returning to its callback', async () => {
    const res = await post('/sign-in/social', { provider: 'google', callbackURL: '/' });
    expect(res.status, await res.clone().text()).toBe(200);
    const { url, redirect } = (await res.json()) as { url: string; redirect: boolean };
    expect(redirect).toBe(true);
    const google = new URL(url);
    expect(google.host).toBe('accounts.google.com');
    expect(google.searchParams.get('client_id')).toBe(process.env['GOOGLE_CLIENT_ID']);
    expect(google.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/google`);
    expect(google.searchParams.get('state')).toBeTruthy();
    // The state it will check on the way back was stored, so the callback can
    // tell this round trip from a forged one.
    expect(cookieOf(res)).toContain('state');
  });
});
