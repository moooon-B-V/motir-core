import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { importSourceIdentityRepository } from '@/lib/repositories/importSourceIdentityRepository';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { linearImportOAuthService } from '@/lib/services/linearImportOAuthService';
import { LinearOAuthExchangeError } from '@/lib/import/linear/errors';
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

interface TokenStubResponse {
  status?: number;
  body: unknown;
  /** Held open until this resolves — lets a test pin a concurrent interleaving. */
  gate?: Promise<void>;
}

/** Stub `fetch` so Linear's token endpoint answers each POST from `responses`
 *  (the last entry repeats), and RECORD every posted body — the recording is
 *  what proves which grant type ran and which refresh token was replayed. */
function mockLinearToken(responses: TokenStubResponse[]): URLSearchParams[] {
  const calls: URLSearchParams[] = [];
  let served = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('api.linear.app/oauth/token')) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      calls.push(new URLSearchParams(String(init?.body ?? '')));
      const spec = responses[Math.min(served, responses.length - 1)]!;
      served += 1;
      if (spec.gate) await spec.gate;
      return new Response(JSON.stringify(spec.body), {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** The happy-path token stub: Linear returns an access token AND — since the
 *  2026-04-01 refresh-token migration — a refresh token beside it. */
function mockLinearTokenOk(
  accessToken = 'lin_oauth_token',
  expiresIn?: number,
  refreshToken: string | undefined = 'lin_refresh_token',
): URLSearchParams[] {
  return mockLinearToken([
    {
      body: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
      },
    },
  ]);
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
    mockLinearTokenOk('lin_secret_token', 86_399, 'lin_secret_refresh');

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
    // MOTIR-2434 — the REFRESH token is captured too. Without it the 24-hour
    // access token is unrenewable and the connection dies the next day.
    expect(row!.refreshTokenEncrypted).not.toBeNull();
    expect(row!.refreshTokenEncrypted).not.toBe('lin_secret_refresh');
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('lin_secret_refresh');
    expect(row!.expiresAt).not.toBeNull();
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

// The read-back seam (the read-back-DTO discipline, notes.html #143/#144): the
// connector (MOTIR-940) reads its token back through this exact accessor — so
// what the connect flow STORES must be what it returns, and a token Linear has
// since expired must come back RENEWED rather than replayed (MOTIR-2434).
describe('linearImportOAuthService.getFreshConnection', () => {
  const HOUR_AGO = () => new Date(Date.now() - 60 * 60_000);

  async function storeIdentity(
    member: WorkspaceContext,
    args: { accessToken: string; refreshToken?: string | null; expiresAt: Date | null },
  ): Promise<void> {
    await importSourceIdentityService.upsertIdentity({
      userId: member.userId,
      workspaceId: member.workspaceId,
      source: 'linear',
      accessToken: args.accessToken,
      refreshToken: args.refreshToken ?? null,
      expiresAt: args.expiresAt,
    });
  }

  const readBack = (member: WorkspaceContext) =>
    importSourceIdentityService.getLiveToken({
      userId: member.userId,
      workspaceId: member.workspaceId,
      source: 'linear',
    });

  it('returns null when the member has not connected Linear', async () => {
    const member = await makeMember('linear-none@example.com');
    expect(await linearImportOAuthService.getFreshConnection(member)).toBeNull();
  });

  it('reads the stored token back untouched while it is unexpired (no refresh POST)', async () => {
    const member = await makeMember('linear-readback@example.com');
    await storeIdentity(member, {
      accessToken: 'stored_token',
      refreshToken: 'refresh_1',
      expiresAt: new Date(Date.now() + 12 * 60 * 60_000),
    });
    const calls = mockLinearToken([{ body: { access_token: 'should_not_be_used' } }]);

    expect(await linearImportOAuthService.getFreshConnection(member)).toEqual({
      accessToken: 'stored_token',
    });
    expect(calls).toHaveLength(0);
  });

  it('refreshes an EXPIRED token and re-persists the rotated pair + new expiry', async () => {
    const member = await makeMember('linear-refresh@example.com');
    await storeIdentity(member, {
      accessToken: 'old_token',
      refreshToken: 'refresh_1',
      expiresAt: HOUR_AGO(),
    });
    const calls = mockLinearToken([
      { body: { access_token: 'fresh_token', refresh_token: 'refresh_2', expires_in: 86_399 } },
    ]);

    const live = await linearImportOAuthService.getFreshConnection(member);
    expect(live).toEqual({ accessToken: 'fresh_token' });

    // The refresh grant ran — with the stored refresh token, not the code grant.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.get('grant_type')).toBe('refresh_token');
    expect(calls[0]!.get('refresh_token')).toBe('refresh_1');

    const after = await readBack(member);
    expect(after?.accessToken).toBe('fresh_token');
    expect(after?.refreshToken).toBe('refresh_2');
    expect(after!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshes a token that is merely WITHIN the expiry skew, not yet expired', async () => {
    const member = await makeMember('linear-skew@example.com');
    await storeIdentity(member, {
      accessToken: 'old_token',
      refreshToken: 'refresh_1',
      // Alive for another 30s — inside the 60s skew, so a call starting now must
      // not race the boundary mid-request.
      expiresAt: new Date(Date.now() + 30_000),
    });
    const calls = mockLinearToken([{ body: { access_token: 'fresh_token', expires_in: 86_399 } }]);

    expect(await linearImportOAuthService.getFreshConnection(member)).toEqual({
      accessToken: 'fresh_token',
    });
    expect(calls).toHaveLength(1);
    // Linear omitted a rotated refresh token — the prior one is KEPT, not nulled.
    expect((await readBack(member))?.refreshToken).toBe('refresh_1');
  });

  it('surfaces a TYPED error when the refresh is rejected (not an opaque 401 from the connector)', async () => {
    const member = await makeMember('linear-refresh-fail@example.com');
    await storeIdentity(member, {
      accessToken: 'old_token',
      refreshToken: 'refresh_dead',
      expiresAt: HOUR_AGO(),
    });
    mockLinearToken([{ status: 400, body: { error: 'invalid_grant' } }]);

    await expect(linearImportOAuthService.getFreshConnection(member)).rejects.toBeInstanceOf(
      LinearOAuthExchangeError,
    );
    // The dead grant is left intact — nothing is silently cleared underneath the
    // member; re-connecting is what replaces it.
    expect((await readBack(member))?.accessToken).toBe('old_token');
  });

  it('throws the typed error when the token is expired but no refresh token is stored (a pre-MOTIR-2434 grant)', async () => {
    const member = await makeMember('linear-norefresh@example.com');
    await storeIdentity(member, { accessToken: 'old_token', expiresAt: HOUR_AGO() });

    await expect(linearImportOAuthService.getFreshConnection(member)).rejects.toThrow(
      /no refresh token/i,
    );
  });

  // Linear grants "a 30-minute grace period to allow for network errors" on
  // consuming a refresh token: two runs that both find the token expired each
  // replay the SAME stored refresh token, and the second is answered rather than
  // rejected. The gate pins that interleaving (both read before either writes) so
  // the race is asserted, not hoped for.
  it('does not hard-fail when two refreshes race inside the grace period', async () => {
    const member = await makeMember('linear-grace@example.com');
    await storeIdentity(member, {
      accessToken: 'old_token',
      refreshToken: 'refresh_1',
      expiresAt: HOUR_AGO(),
    });

    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const calls = mockLinearToken([
      // Held until the second POST lands, so neither call can persist first.
      { body: { access_token: 'fresh_a', refresh_token: 'refresh_2', expires_in: 86_399 }, gate },
      { body: { access_token: 'fresh_b', refresh_token: 'refresh_3', expires_in: 86_399 } },
    ]);
    const both = Promise.all([
      linearImportOAuthService.getFreshConnection(member),
      linearImportOAuthService.getFreshConnection(member),
    ]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    openGate();

    const [a, b] = await both;
    // NEITHER call fails: both come back with a usable token.
    expect(a?.accessToken).toBeTruthy();
    expect(b?.accessToken).toBeTruthy();
    expect([a?.accessToken, b?.accessToken].sort()).toEqual(['fresh_a', 'fresh_b']);
    // Both replayed the SAME refresh token — the grace period is what makes that
    // safe, which is why this path takes no lock and does not serialise.
    expect(calls.map((c) => c.get('refresh_token'))).toEqual(['refresh_1', 'refresh_1']);

    // The store settles on one of the two rotated pairs — consistent, unexpired.
    const after = await readBack(member);
    expect(['fresh_a', 'fresh_b']).toContain(after?.accessToken);
    expect(['refresh_2', 'refresh_3']).toContain(after?.refreshToken);
    expect(after!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
