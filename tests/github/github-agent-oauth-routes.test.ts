import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-683 · MOTIR-6519 — HTTP smoke for the Motir Agent link routes. The
// only permitted mock is `getSession`; GitHub is stubbed with a global `fetch`
// mock and persistence hits the real Postgres.

const session: { current: { user: { id: string } } | null } = { current: null };
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const { GET: startGET, GITHUB_AGENT_OAUTH_STATE_COOKIE } =
  await import('@/app/api/github/agent/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/github/agent/oauth/callback/route');
const { POST: unlinkPOST } = await import('@/app/api/github/agent/unlink/route');

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function mockGithubOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/login/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'ghu_route',
            expires_in: 28_800,
            refresh_token: 'ghr_route',
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 77, login: 'route-user' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
}

function callbackRequest(query: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/github/agent/oauth/callback?${query}`, {
    headers: cookie !== undefined ? { cookie: `${GITHUB_AGENT_OAUTH_STATE_COOKIE}=${cookie}` } : {},
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  vi.stubEnv('GITHUB_AGENT_APP_CLIENT_ID', 'Iv1.agentclient');
  vi.stubEnv('GITHUB_AGENT_APP_CLIENT_SECRET', 'agent-secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/github/agent/oauth/start', () => {
  it('401s when unauthenticated', async () => {
    const res = await startGET(
      new NextRequest('http://localhost:3000/api/github/agent/oauth/start'),
    );
    expect(res.status).toBe(401);
  });

  it('redirects to GitHub with the Motir Agent client id and a single-use state cookie', async () => {
    session.current = { user: { id: 'user-1' } };
    const res = await startGET(
      new NextRequest('http://localhost:3000/api/github/agent/oauth/start?from=accountGit'),
    );
    expect(REDIRECT_STATUSES).toContain(res.status);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('client_id')).toBe('Iv1.agentclient');
    const state = location.searchParams.get('state')!;
    const cookie = (res as NextResponse).cookies.get(GITHUB_AGENT_OAUTH_STATE_COOKIE)!;
    expect(cookie.value).toBe(`${state}.accountGit`);
    expect(cookie.httpOnly).toBe(true);
  });

  it('bounces to the account Git page as not_configured when the App is unwired (AC4)', async () => {
    session.current = { user: { id: 'user-1' } };
    vi.stubEnv('GITHUB_AGENT_APP_CLIENT_ID', '');
    const res = await startGET(
      new NextRequest('http://localhost:3000/api/github/agent/oauth/start'),
    );
    expect(res.headers.get('location')).toMatch(
      /\/settings\/account\/git\?githubAgent=not_configured$/,
    );
  });
});

describe('GET /api/github/agent/oauth/callback', () => {
  it('refuses a state that does not match the cookie, and stores nothing', async () => {
    const user = await usersService.createUser({
      email: 'a@example.com',
      password: 'hunter2hunter2',
      name: 'A',
    });
    session.current = { user: { id: user.id } };
    mockGithubOk();
    const res = await callbackGET(callbackRequest('code=c&state=other', 'mine'));
    expect(res.headers.get('location')).toMatch(/githubAgent=state_error$/);
    expect(await adminDb.githubAgentAuthorization.count()).toBe(0);
  });

  it('links the member on a matching state and returns to the surface it started from', async () => {
    const user = await usersService.createUser({
      email: 'b@example.com',
      password: 'hunter2hunter2',
      name: 'B',
    });
    session.current = { user: { id: user.id } };
    mockGithubOk();
    const res = await callbackGET(
      callbackRequest('code=c&state=n0nce', 'n0nce.projectRepositories'),
    );
    expect(res.headers.get('location')).toMatch(
      /\/settings\/project\/repositories\?githubAgent=linked$/,
    );
    const row = await adminDb.githubAgentAuthorization.findUnique({ where: { userId: user.id } });
    expect(row?.githubLogin).toBe('route-user');
    expect(row?.accessTokenEncrypted).not.toContain('ghu_route');
  });

  it('reads a declined authorization as denied', async () => {
    session.current = { user: { id: 'user-1' } };
    const res = await callbackGET(callbackRequest('error=access_denied', 'n'));
    expect(res.headers.get('location')).toMatch(/\/settings\/account\/git\?githubAgent=denied$/);
  });
});

describe('POST /api/github/agent/unlink', () => {
  it('401s when unauthenticated', async () => {
    const res = await unlinkPOST();
    expect(res.status).toBe(401);
  });

  it('unlinks the member and answers { unlinked }', async () => {
    const user = await usersService.createUser({
      email: 'c@example.com',
      password: 'hunter2hunter2',
      name: 'C',
    });
    session.current = { user: { id: user.id } };
    mockGithubOk();
    await callbackGET(callbackRequest('code=c&state=n', 'n'));
    const res = await unlinkPOST();
    expect(await res.json()).toEqual({ unlinked: true });
    expect(await adminDb.githubAgentAuthorization.count()).toBe(0);
  });
});
