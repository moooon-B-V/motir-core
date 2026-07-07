import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { importSourceIdentityRepository } from '@/lib/repositories/importSourceIdentityRepository';
import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import type { WorkspaceContext } from '@/lib/workspaces';
import { truncateAuthTables } from '../helpers/db';

// Story 7.16 · MOTIR-1655 — HTTP smoke for the two Linear import "Connect" OAuth
// routes. Mirrors tests/github/github-oauth-routes.test.ts: the Linear token
// exchange is stubbed via a global `fetch` mock and persistence hits the real
// Postgres through the real service → substrate → repository → Prisma chain.
//
// The routes read the active workspace through `getWorkspaceContext` (the
// `getSession` analogue), which the test env can't supply (no cookies) — so we
// stub ONLY that, PARTIAL (importOriginal) so the real `withUserContext`
// RLS-binding transaction the substrate depends on is preserved. Same "mock the
// context resolver the env can't provide" exception the ready-routes suite takes.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET: startGET, LINEAR_OAUTH_STATE_COOKIE } =
  await import('@/app/api/import/linear/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/import/linear/oauth/callback/route');

// Decrypt exactly as the substrate does (same env-key resolution) to prove the
// stored ciphertext is recoverable and not plaintext.
const { decryptToken } = createTokenCrypto([
  'IMPORT_TOKEN_ENCRYPTION_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
]);

const PASSWORD = 'hunter2hunter2';
const BASE = 'http://localhost:3000';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** Stub `fetch` so the Linear token endpoint returns `access_token`. */
function mockLinearTokenOk(accessToken = 'lin_oauth_token', expiresIn?: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.linear.app/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: expiresIn,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

/** Create a real member + workspace the way the substrate suite does. */
async function makeMember(email: string): Promise<WorkspaceContext> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Member' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Workspace ${email}`,
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/import/linear/oauth/start', () => {
  it('401s when there is no workspace context (unauthenticated)', async () => {
    const res = await startGET(new NextRequest(`${BASE}/api/import/linear/oauth/start`));
    expect(res.status).toBe(401);
  });

  it('redirects a signed-in member to Linear with a read-scoped state, and sets the state cookie', async () => {
    ctxRef.current = { userId: 'user-123', workspaceId: 'ws-123' };
    const res = await startGET(new NextRequest(`${BASE}/api/import/linear/oauth/start`));

    expect(REDIRECT_STATUSES).toContain(res.status);
    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('client_id')).toBe(process.env['LINEAR_OAUTH_CLIENT_ID']);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    // The CSRF cookie is set to the same state the authorize URL carries.
    const cookie = (res as NextResponse).cookies.get(LINEAR_OAUTH_STATE_COOKIE);
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
  });

  it('redirects with linear_not_configured when the OAuth app is unwired', async () => {
    vi.stubEnv('LINEAR_OAUTH_CLIENT_ID', '');
    vi.stubEnv('LINEAR_OAUTH_CLIENT_SECRET', '');
    ctxRef.current = { userId: 'user-123', workspaceId: 'ws-123' };

    const res = await startGET(new NextRequest(`${BASE}/api/import/linear/oauth/start`));
    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('import=linear_not_configured');
  });
});

describe('GET /api/import/linear/oauth/callback', () => {
  const callbackReq = (query: string, cookie?: string) =>
    new NextRequest(`${BASE}/api/import/linear/oauth/callback${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('401s when there is no workspace context (unauthenticated)', async () => {
    const res = await callbackGET(callbackReq('?code=c&state=s', 'linear_import_oauth_state=s'));
    expect(res.status).toBe(401);
  });

  it('redirects with linear_state_error when the CSRF state does not match the cookie', async () => {
    ctxRef.current = { userId: 'user-123', workspaceId: 'ws-123' };
    const res = await callbackGET(
      callbackReq('?code=c&state=zzz', 'linear_import_oauth_state=yyy'),
    );
    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('import=linear_state_error');
  });

  it('redirects with linear_denied when the member declines at Linear', async () => {
    ctxRef.current = { userId: 'user-123', workspaceId: 'ws-123' };
    const res = await callbackGET(
      callbackReq('?error=access_denied&state=s', 'linear_import_oauth_state=s'),
    );
    expect(res.headers.get('location')).toContain('import=linear_denied');
  });

  it('completes the grant, persists an ENCRYPTED linear identity, and redirects linear_connected', async () => {
    const member = await makeMember('linear-router@example.com');
    ctxRef.current = member;
    mockLinearTokenOk('lin_secret_token');

    const res = await callbackGET(
      callbackReq('?code=goodcode&state=matching', 'linear_import_oauth_state=matching'),
    );

    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('import=linear_connected');
    // Single-use nonce cleared on the terminal outcome.
    expect((res as NextResponse).cookies.get(LINEAR_OAUTH_STATE_COOKIE)?.value).toBe('');

    const row = await withSystemContext((tx) =>
      importSourceIdentityRepository.findByUserSource(
        member.userId,
        'linear',
        member.workspaceId,
        tx,
      ),
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe('linear');
    // Stored ENCRYPTED (not plaintext), and recoverable to the exchanged token.
    expect(row!.accessTokenEncrypted).not.toBe('lin_secret_token');
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('lin_secret_token');
  });

  it('redirects with linear_error when the token exchange returns no access_token', async () => {
    const member = await makeMember('linear-fail@example.com');
    ctxRef.current = member;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const res = await callbackGET(
      callbackReq('?code=badcode&state=matching', 'linear_import_oauth_state=matching'),
    );
    expect(res.headers.get('location')).toContain('import=linear_error');

    // Nothing persisted on a failed exchange.
    const count = await withSystemContext((tx) => tx.importSourceIdentity.count());
    expect(count).toBe(0);
  });
});
