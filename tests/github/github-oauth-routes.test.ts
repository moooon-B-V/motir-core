import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-1498 — HTTP smoke for the two OAuth routes. The only
// permitted mock is `getSession` (CLAUDE.md: the test env has no cookies);
// the GitHub HTTP calls are stubbed via a global `fetch` mock, and persistence
// hits the real Postgres.

const session: { current: { user: { id: string } } | null } = { current: null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const { GET: startGET, GITHUB_OAUTH_STATE_COOKIE } =
  await import('@/app/api/github/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/github/oauth/callback/route');

const PASSWORD = 'hunter2hunter2';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function mockGithubOk(
  user: { id: number; login: string; avatar_url: string | null } = {
    id: 321,
    login: 'router-user',
    avatar_url: 'https://gh/r.png',
  },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_router_token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/github/oauth/start', () => {
  it('401s when unauthenticated', async () => {
    const res = await startGET(new NextRequest('http://localhost:3000/api/github/oauth/start'));
    expect(res.status).toBe(401);
  });

  it('redirects a signed-in member to GitHub with a state, and sets the state cookie', async () => {
    session.current = { user: { id: 'user-123' } };
    const res = await startGET(new NextRequest('http://localhost:3000/api/github/oauth/start'));

    expect(REDIRECT_STATUSES).toContain(res.status);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(url.searchParams.get('client_id')).toBe(process.env['GITHUB_APP_CLIENT_ID']);

    // The CSRF cookie is set to the same state the authorize URL carries.
    const cookie = (res as NextResponse).cookies.get(GITHUB_OAUTH_STATE_COOKIE);
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
  });
});

describe('GET /api/github/oauth/callback', () => {
  const callbackReq = (query: string, cookie?: string) =>
    new NextRequest(`http://localhost:3000/api/github/oauth/callback${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('401s when unauthenticated', async () => {
    const res = await callbackGET(callbackReq('?code=c&state=s', 'github_oauth_state=s'));
    expect(res.status).toBe(401);
  });

  it('redirects with a state_error when the CSRF state does not match the cookie', async () => {
    session.current = { user: { id: 'user-123' } };
    const res = await callbackGET(callbackReq('?code=c&state=zzz', 'github_oauth_state=yyy'));
    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('github=state_error');
  });

  it('redirects with denied when GitHub bounces back an error', async () => {
    session.current = { user: { id: 'user-123' } };
    const res = await callbackGET(
      callbackReq('?error=access_denied&state=s', 'github_oauth_state=s'),
    );
    expect(res.headers.get('location')).toContain('github=denied');
  });

  it('completes the grant, persists the identity, and redirects connected', async () => {
    const user = await usersService.createUser({
      email: 'router@example.com',
      password: PASSWORD,
      name: 'Router',
    });
    session.current = { user: { id: user.id } };
    mockGithubOk({ id: 555, login: 'gh-router', avatar_url: null });

    const res = await callbackGET(
      callbackReq('?code=goodcode&state=matching', 'github_oauth_state=matching'),
    );

    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('github=connected');

    const row = await withSystemContext((tx) =>
      tx.githubIdentity.findUnique({ where: { userId: user.id } }),
    );
    expect(row).not.toBeNull();
    expect(row!.githubUserId).toBe('555');
    expect(row!.githubLogin).toBe('gh-router');
  });
});
