import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { importSourceIdentityRepository } from '@/lib/repositories/importSourceIdentityRepository';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { planeImportOAuthService } from '@/lib/services/planeImportOAuthService';
import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import type { WorkspaceContext } from '@/lib/workspaces';
import { truncateAuthTables } from '../helpers/db';

// Story 7.16 · MOTIR-1656 — HTTP smoke for the two Plane import "Connect" OAuth
// routes + a service-level read-back check. Mirrors jira-oauth-routes.test.ts:
// the only mock is the session (CLAUDE.md — the test env has no cookies), here
// `auth.api.getSession`, which the real workspace-context resolver reads and
// then self-heals against the real Postgres. Plane's token endpoint is stubbed
// via a global `fetch` mock; persistence + encryption hit the real DB through
// the real service → substrate → repository → Prisma chain.
//
// Covers Plane CLOUD (default base URL → api.plane.so) AND a SELF-HOSTED base
// URL (its own origin + a PLANE_OAUTH_INSTANCES app), per the card's acceptance.

const session: { current: { user: { id: string; name?: string } } | null } = { current: null };
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: async () => session.current } },
  getSession: async () => session.current,
}));

const {
  GET: startGET,
  PLANE_OAUTH_STATE_COOKIE,
  PLANE_OAUTH_BASE_COOKIE,
  PLANE_OAUTH_SLUG_COOKIE,
} = await import('@/app/api/import/plane/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/import/plane/oauth/callback/route');

// Decrypt exactly as the substrate does (same env-key resolution) to prove the
// stored ciphertext is recoverable and not plaintext.
const { decryptToken } = createTokenCrypto([
  'IMPORT_TOKEN_ENCRYPTION_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
]);

const PASSWORD = 'hunter2hunter2';
const BASE = 'http://localhost:3000';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const CLOUD_TOKEN_URL = 'https://api.plane.so/auth/o/token/';
const SELF_HOST = 'https://plane.acme.test';
const SELF_HOST_TOKEN_URL = 'https://plane.acme.test/auth/o/token/';
const SELF_HOST_APP = JSON.stringify({
  'https://plane.acme.test': { clientId: 'self-client', clientSecret: 'self-secret' },
});

/** Stub `fetch` so a Plane token endpoint returns `access_token`. `onlyUrl`
 *  scopes the OK response to one instance's token URL; any other fetch throws. */
function mockPlaneTokenOk(opts?: {
  onlyUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  workspaceSlug?: string;
}): void {
  const target = opts?.onlyUrl ?? CLOUD_TOKEN_URL;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === target) {
        return new Response(
          JSON.stringify({
            access_token: opts?.accessToken ?? 'plane_oauth_token',
            token_type: 'Bearer',
            refresh_token: opts?.refreshToken,
            expires_in: opts?.expiresIn,
            workspace_slug: opts?.workspaceSlug,
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

const cookieHeader = (parts: Record<string, string>): string =>
  Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/import/plane/oauth/start', () => {
  it('401s when there is no session (unauthenticated)', async () => {
    const res = await startGET(new NextRequest(`${BASE}/api/import/plane/oauth/start`));
    expect(res.status).toBe(401);
  });

  it('redirects a signed-in member to Plane Cloud with a state, and sets the state cookie', async () => {
    const member = await makeMember('plane-start@example.com');
    session.current = { user: { id: member.userId } };

    const res = await startGET(new NextRequest(`${BASE}/api/import/plane/oauth/start`));

    expect(REDIRECT_STATUSES).toContain(res.status);
    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.plane.so/auth/o/authorize-app/');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(process.env['PLANE_OAUTH_CLIENT_ID']);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();

    const cookie = (res as NextResponse).cookies.get(PLANE_OAUTH_STATE_COOKIE);
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
    // No base cookie set when the default (Cloud) is used.
    expect((res as NextResponse).cookies.get(PLANE_OAUTH_BASE_COOKIE)?.value).toBeFalsy();
  });

  it('redirects to a SELF-HOSTED instance and stashes the base URL + slug when supplied', async () => {
    vi.stubEnv('PLANE_OAUTH_INSTANCES', SELF_HOST_APP);
    const member = await makeMember('plane-selfhost@example.com');
    session.current = { user: { id: member.userId } };

    const res = await startGET(
      new NextRequest(
        `${BASE}/api/import/plane/oauth/start?baseUrl=${encodeURIComponent(SELF_HOST)}&workspaceSlug=acme`,
      ),
    );

    expect(REDIRECT_STATUSES).toContain(res.status);
    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://plane.acme.test/auth/o/authorize-app/');
    expect(url.searchParams.get('client_id')).toBe('self-client');

    expect((res as NextResponse).cookies.get(PLANE_OAUTH_BASE_COOKIE)?.value).toBe(SELF_HOST);
    expect((res as NextResponse).cookies.get(PLANE_OAUTH_SLUG_COOKIE)?.value).toBe('acme');
  });

  it('redirects with plane_not_configured when Plane Cloud is unwired', async () => {
    vi.stubEnv('PLANE_OAUTH_CLIENT_ID', '');
    vi.stubEnv('PLANE_OAUTH_CLIENT_SECRET', '');
    const member = await makeMember('plane-unwired@example.com');
    session.current = { user: { id: member.userId } };

    const res = await startGET(new NextRequest(`${BASE}/api/import/plane/oauth/start`));
    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('import=plane_not_configured');
  });

  it('redirects with plane_not_configured for a self-hosted URL with no PLANE_OAUTH_INSTANCES entry', async () => {
    const member = await makeMember('plane-noapp@example.com');
    session.current = { user: { id: member.userId } };

    const res = await startGET(
      new NextRequest(
        `${BASE}/api/import/plane/oauth/start?baseUrl=${encodeURIComponent(SELF_HOST)}`,
      ),
    );
    expect(res.headers.get('location')).toContain('import=plane_not_configured');
  });

  it('redirects with plane_invalid_url when the instance URL is malformed', async () => {
    const member = await makeMember('plane-badurl@example.com');
    session.current = { user: { id: member.userId } };

    const res = await startGET(
      new NextRequest(`${BASE}/api/import/plane/oauth/start?baseUrl=not-a-url`),
    );
    expect(res.headers.get('location')).toContain('import=plane_invalid_url');
  });
});

describe('GET /api/import/plane/oauth/callback', () => {
  const callbackReq = (query: string, cookie?: string) =>
    new NextRequest(`${BASE}/api/import/plane/oauth/callback${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('401s when there is no session (unauthenticated)', async () => {
    const res = await callbackGET(
      callbackReq('?code=c&state=s', cookieHeader({ [PLANE_OAUTH_STATE_COOKIE]: 's' })),
    );
    expect(res.status).toBe(401);
  });

  it('redirects with plane_state_error when the CSRF state does not match the cookie', async () => {
    const member = await makeMember('plane-state@example.com');
    session.current = { user: { id: member.userId } };
    const res = await callbackGET(
      callbackReq('?code=c&state=zzz', cookieHeader({ [PLANE_OAUTH_STATE_COOKIE]: 'yyy' })),
    );
    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('import=plane_state_error');
  });

  it('redirects with plane_denied when the member declines at Plane', async () => {
    const member = await makeMember('plane-denied@example.com');
    session.current = { user: { id: member.userId } };
    const res = await callbackGET(
      callbackReq(
        '?error=access_denied&state=s',
        cookieHeader({ [PLANE_OAUTH_STATE_COOKIE]: 's' }),
      ),
    );
    expect(res.headers.get('location')).toContain('import=plane_denied');
  });

  it('completes the CLOUD grant, persists an ENCRYPTED plane identity with baseUrl + slug, redirects plane_connected', async () => {
    const member = await makeMember('plane-cloud@example.com');
    session.current = { user: { id: member.userId } };
    mockPlaneTokenOk({ accessToken: 'plane_secret_token' });

    const res = await callbackGET(
      callbackReq(
        '?code=goodcode&state=matching',
        cookieHeader({ [PLANE_OAUTH_STATE_COOKIE]: 'matching', [PLANE_OAUTH_SLUG_COOKIE]: 'acme' }),
      ),
    );

    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('import=plane_connected');
    // Single-use nonce cleared on the terminal outcome.
    expect((res as NextResponse).cookies.get(PLANE_OAUTH_STATE_COOKIE)?.value).toBe('');

    const row = await withSystemContext((tx) =>
      importSourceIdentityRepository.findByUserSource(
        member.userId,
        'plane',
        member.workspaceId,
        tx,
      ),
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe('plane');
    // Stored ENCRYPTED (not plaintext), recoverable to the exchanged token.
    expect(row!.accessTokenEncrypted).not.toBe('plane_secret_token');
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('plane_secret_token');
    // The connector-facing metadata: Cloud API origin + the workspace slug.
    expect(row!.metadata).toMatchObject({ baseUrl: 'https://api.plane.so', workspaceSlug: 'acme' });
  });

  it('completes a SELF-HOSTED grant against the stashed base URL and stores that origin', async () => {
    vi.stubEnv('PLANE_OAUTH_INSTANCES', SELF_HOST_APP);
    const member = await makeMember('plane-selfhost-cb@example.com');
    session.current = { user: { id: member.userId } };
    // Token comes back from the SELF-HOST endpoint, carrying its own slug.
    mockPlaneTokenOk({
      onlyUrl: SELF_HOST_TOKEN_URL,
      accessToken: 'self_token',
      workspaceSlug: 'acme-internal',
    });

    const res = await callbackGET(
      callbackReq(
        '?code=goodcode&state=matching',
        cookieHeader({
          [PLANE_OAUTH_STATE_COOKIE]: 'matching',
          [PLANE_OAUTH_BASE_COOKIE]: SELF_HOST,
        }),
      ),
    );

    expect(res.headers.get('location')).toContain('import=plane_connected');
    const row = await withSystemContext((tx) =>
      importSourceIdentityRepository.findByUserSource(
        member.userId,
        'plane',
        member.workspaceId,
        tx,
      ),
    );
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('self_token');
    // Stored the SELF-HOST origin (not Cloud), and preferred the token's slug.
    expect(row!.metadata).toMatchObject({
      baseUrl: 'https://plane.acme.test',
      workspaceSlug: 'acme-internal',
    });
  });

  it('redirects with plane_error when the token exchange returns no access_token', async () => {
    const member = await makeMember('plane-fail@example.com');
    session.current = { user: { id: member.userId } };
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
      callbackReq(
        '?code=badcode&state=matching',
        cookieHeader({ [PLANE_OAUTH_STATE_COOKIE]: 'matching' }),
      ),
    );
    expect(res.headers.get('location')).toContain('import=plane_error');

    const count = await withSystemContext((tx) => tx.importSourceIdentity.count());
    expect(count).toBe(0);
  });
});

// The read-back seam (the read-back-DTO discipline, notes.html #143/#144): the
// connector (MOTIR-1639) reads its token + baseUrl + workspaceSlug back through
// this exact accessor — so what the connect flow STORES must be what it returns.
describe('planeImportOAuthService.getFreshConnection', () => {
  it('returns null when the member has not connected Plane', async () => {
    const member = await makeMember('plane-none@example.com');
    const live = await planeImportOAuthService.getFreshConnection(member);
    expect(live).toBeNull();
  });

  it('reads the stored token + baseUrl + workspaceSlug back (no refresh when unexpired)', async () => {
    const member = await makeMember('plane-readback@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId: member.userId,
      workspaceId: member.workspaceId,
      source: 'plane',
      accessToken: 'stored_token',
      expiresAt: null, // non-expiring → no refresh path
      metadata: { baseUrl: 'https://api.plane.so', workspaceSlug: 'acme' },
    });

    const live = await planeImportOAuthService.getFreshConnection(member);
    expect(live).toEqual({
      accessToken: 'stored_token',
      baseUrl: 'https://api.plane.so',
      workspaceSlug: 'acme',
    });
  });

  it('refreshes an expired token against the stored instance and re-persists it', async () => {
    vi.stubEnv('PLANE_OAUTH_INSTANCES', SELF_HOST_APP);
    const member = await makeMember('plane-refresh@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId: member.userId,
      workspaceId: member.workspaceId,
      source: 'plane',
      accessToken: 'old_token',
      refreshToken: 'refresh_1',
      expiresAt: new Date(Date.now() - 60_000), // already expired
      metadata: { baseUrl: SELF_HOST, workspaceSlug: 'acme-internal' },
    });
    mockPlaneTokenOk({
      onlyUrl: SELF_HOST_TOKEN_URL,
      accessToken: 'fresh_token',
      refreshToken: 'refresh_2',
      expiresIn: 3600,
    });

    const live = await planeImportOAuthService.getFreshConnection(member);
    expect(live?.accessToken).toBe('fresh_token');
    expect(live?.baseUrl).toBe(SELF_HOST);

    // The rotated refresh token + fresh access token are persisted (metadata kept).
    const readAgain = await importSourceIdentityService.getLiveToken({
      userId: member.userId,
      workspaceId: member.workspaceId,
      source: 'plane',
    });
    expect(readAgain?.accessToken).toBe('fresh_token');
    expect(readAgain?.refreshToken).toBe('refresh_2');
    expect(readAgain?.metadata).toMatchObject({
      baseUrl: SELF_HOST,
      workspaceSlug: 'acme-internal',
    });
  });

  it('throws when the token is expired but no refresh token is stored', async () => {
    const member = await makeMember('plane-norefresh@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId: member.userId,
      workspaceId: member.workspaceId,
      source: 'plane',
      accessToken: 'old_token',
      expiresAt: new Date(Date.now() - 60_000),
      metadata: { baseUrl: 'https://api.plane.so' },
    });

    await expect(planeImportOAuthService.getFreshConnection(member)).rejects.toThrow(
      /no refresh token/i,
    );
  });
});
