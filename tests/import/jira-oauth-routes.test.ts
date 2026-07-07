import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { jiraOAuthService, jiraApiBaseUrl } from '@/lib/services/jiraOAuthService';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.16 · MOTIR-1654 — HTTP smoke for the Jira 3LO OAuth routes + a
// service-level check of the refresh helper. The only mock is the session
// (CLAUDE.md: the test env has no cookies) — here `auth.api.getSession`, which
// the workspace-context resolver reads; the real resolver then self-heals the
// user's workspace against the real Postgres. Atlassian's HTTP is stubbed via a
// global `fetch` mock; persistence + encryption hit the real DB.

const session: { current: { user: { id: string; name?: string } } | null } = { current: null };
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: async () => session.current } },
  getSession: async () => session.current,
}));

const {
  GET: startGET,
  JIRA_OAUTH_STATE_COOKIE,
  JIRA_OAUTH_VERIFIER_COOKIE,
} = await import('@/app/api/import/jira/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/import/jira/oauth/callback/route');

const PASSWORD = 'hunter2hunter2';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stub Atlassian's token + accessible-resources endpoints. `onToken` picks the
 *  body per grant type so the same mock serves the code exchange AND refresh. */
function mockAtlassian(opts?: {
  token?: Record<string, unknown>;
  refresh?: Record<string, unknown>;
  resources?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // accessible-resources shares the /oauth/token prefix — match it FIRST.
    if (url.includes('/accessible-resources')) {
      return jsonResponse(
        opts?.resources ?? [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }],
      );
    }
    if (url.includes('/oauth/token')) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { grant_type?: string }) : {};
      if (body.grant_type === 'refresh_token') {
        return jsonResponse(
          opts?.refresh ?? {
            access_token: 'jira_access_refreshed',
            refresh_token: 'jira_refresh_rotated',
            expires_in: 3600,
            scope: 'read:jira-work offline_access',
          },
        );
      }
      return jsonResponse(
        opts?.token ?? {
          access_token: 'jira_access_1',
          refresh_token: 'jira_refresh_1',
          expires_in: 3600,
          scope: 'read:jira-work offline_access',
        },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function createUserWithWorkspace(
  email: string,
): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Jira Tester' });
  // Self-heals a workspace for the fresh, zero-membership user (Subtask 1.2.4).
  const workspaceId = await workspacesService.resolveActiveWorkspace(user.id, null, 'Jira Tester');
  if (!workspaceId) throw new Error('expected a self-healed workspace');
  return { userId: user.id, workspaceId };
}

beforeAll(() => {
  process.env['JIRA_OAUTH_CLIENT_ID'] = 'test-jira-client';
  process.env['JIRA_OAUTH_CLIENT_SECRET'] = 'test-jira-secret';
});

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env['JIRA_OAUTH_CLIENT_ID'];
  delete process.env['JIRA_OAUTH_CLIENT_SECRET'];
  await db.$disconnect();
});

describe('GET /api/import/jira/oauth/start', () => {
  it('401s when unauthenticated', async () => {
    const res = await startGET(
      new NextRequest('http://localhost:3000/api/import/jira/oauth/start'),
    );
    expect(res.status).toBe(401);
  });

  it('redirects to Atlassian with state, PKCE + the read scopes, and sets both cookies', async () => {
    const { userId } = await createUserWithWorkspace('start@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };

    const res = await startGET(
      new NextRequest('http://localhost:3000/api/import/jira/oauth/start'),
    );

    expect(REDIRECT_STATUSES).toContain(res.status);
    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.atlassian.com/authorize');
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(url.searchParams.get('client_id')).toBe('test-jira-client');
    expect(url.searchParams.get('scope')).toBe('read:jira-work offline_access');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const stateCookie = (res as NextResponse).cookies.get(JIRA_OAUTH_STATE_COOKIE);
    expect(stateCookie?.value).toBe(state);
    expect(stateCookie?.httpOnly).toBe(true);
    const verifierCookie = (res as NextResponse).cookies.get(JIRA_OAUTH_VERIFIER_COOKIE);
    expect(verifierCookie?.value).toBeTruthy();
    expect(verifierCookie?.httpOnly).toBe(true);
    // The PKCE challenge on the URL is derived from the stashed verifier, never
    // the verifier itself.
    expect(url.searchParams.get('code_challenge')).not.toBe(verifierCookie?.value);
  });

  it('redirects with not_configured when the OAuth app is unwired', async () => {
    const { userId } = await createUserWithWorkspace('unwired@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };
    delete process.env['JIRA_OAUTH_CLIENT_ID'];

    const res = await startGET(
      new NextRequest('http://localhost:3000/api/import/jira/oauth/start'),
    );
    expect(res.headers.get('location')).toContain('jira=not_configured');
    process.env['JIRA_OAUTH_CLIENT_ID'] = 'test-jira-client';
  });
});

describe('GET /api/import/jira/oauth/callback', () => {
  const callbackReq = (query: string, cookie?: string) =>
    new NextRequest(`http://localhost:3000/api/import/jira/oauth/callback${query}`, {
      headers: cookie ? { cookie } : {},
    });

  it('401s when unauthenticated', async () => {
    const res = await callbackGET(
      callbackReq('?code=c&state=s', 'jira_oauth_state=s; jira_oauth_verifier=v'),
    );
    expect(res.status).toBe(401);
  });

  it('redirects state_error when the CSRF state does not match the cookie', async () => {
    const { userId } = await createUserWithWorkspace('mismatch@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };
    const res = await callbackGET(
      callbackReq('?code=c&state=zzz', 'jira_oauth_state=yyy; jira_oauth_verifier=v'),
    );
    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('jira=state_error');
  });

  it('redirects state_error when the PKCE verifier cookie is absent', async () => {
    const { userId } = await createUserWithWorkspace('noverifier@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };
    const res = await callbackGET(callbackReq('?code=c&state=s', 'jira_oauth_state=s'));
    expect(res.headers.get('location')).toContain('jira=state_error');
  });

  it('redirects denied when Atlassian bounces back an error', async () => {
    const { userId } = await createUserWithWorkspace('denied@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };
    const res = await callbackGET(
      callbackReq('?error=access_denied&state=s', 'jira_oauth_state=s; jira_oauth_verifier=v'),
    );
    expect(res.headers.get('location')).toContain('jira=denied');
  });

  it('completes the grant, stores the token ENCRYPTED with the resolved cloud site, and redirects connected', async () => {
    const { userId, workspaceId } = await createUserWithWorkspace('connected@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };
    mockAtlassian();

    const res = await callbackGET(
      callbackReq(
        '?code=goodcode&state=match',
        'jira_oauth_state=match; jira_oauth_verifier=verif',
      ),
    );

    expect(REDIRECT_STATUSES).toContain(res.status);
    expect(res.headers.get('location')).toContain('jira=connected');

    // Stored at rest: the raw column is the versioned ciphertext, NOT plaintext,
    // and the metadata carries the accessible-resource the token maps to.
    const row = await withSystemContext((tx) =>
      tx.importSourceIdentity.findFirst({ where: { userId, source: 'jira' } }),
    );
    expect(row).not.toBeNull();
    expect(row!.accessTokenEncrypted).toMatch(/^v1\./);
    expect(row!.accessTokenEncrypted).not.toContain('jira_access_1');
    expect(row!.refreshTokenEncrypted).toMatch(/^v1\./);
    expect(row!.metadata).toMatchObject({
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
    });

    // Round-trips back to the live plaintext token for the connector to use.
    const live = await importSourceIdentityService.getLiveToken({
      userId,
      workspaceId,
      source: 'jira',
    });
    expect(live?.accessToken).toBe('jira_access_1');
    expect(live?.refreshToken).toBe('jira_refresh_1');
  });

  it('redirects error when accessible-resources resolves no Jira site', async () => {
    const { userId } = await createUserWithWorkspace('nosite@example.com');
    session.current = { user: { id: userId, name: 'Jira Tester' } };
    mockAtlassian({ resources: [] });

    const res = await callbackGET(
      callbackReq('?code=goodcode&state=m', 'jira_oauth_state=m; jira_oauth_verifier=verif'),
    );
    expect(res.headers.get('location')).toContain('jira=error');
  });
});

describe('jiraOAuthService.getFreshConnection (refresh helper)', () => {
  it('returns the stored token unchanged when it has not expired', async () => {
    const { userId, workspaceId } = await createUserWithWorkspace('valid@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId,
      workspaceId,
      source: 'jira',
      accessToken: 'still-good',
      refreshToken: 'refresh-x',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: { cloudId: 'cloud-9', siteUrl: 'https://ok.atlassian.net' },
    });
    // fetch MUST NOT be called — a valid token never refreshes.
    const fetchMock = vi.fn(async () => {
      throw new Error('should not refresh a valid token');
    });
    vi.stubGlobal('fetch', fetchMock);

    const conn = await jiraOAuthService.getFreshConnection({ userId, workspaceId });
    expect(conn).not.toBeNull();
    expect(conn!.accessToken).toBe('still-good');
    expect(conn!.cloudId).toBe('cloud-9');
    expect(conn!.apiBaseUrl).toBe(jiraApiBaseUrl('cloud-9'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token via offline_access and re-stores the rotated token', async () => {
    const { userId, workspaceId } = await createUserWithWorkspace('expired@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId,
      workspaceId,
      source: 'jira',
      accessToken: 'stale',
      refreshToken: 'refresh-old',
      expiresAt: new Date(Date.now() - 1000), // already expired
      metadata: { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' },
    });
    const fetchMock = mockAtlassian();

    const conn = await jiraOAuthService.getFreshConnection({ userId, workspaceId });
    expect(conn!.accessToken).toBe('jira_access_refreshed');
    expect(conn!.apiBaseUrl).toBe('https://api.atlassian.com/ex/jira/cloud-1');
    // It hit the token endpoint with a refresh_token grant.
    const grantTypes = fetchMock.mock.calls
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)).grant_type : null))
      .filter(Boolean);
    expect(grantTypes).toContain('refresh_token');

    // The rotated token + new expiry are persisted (encrypted); metadata survives.
    const live = await importSourceIdentityService.getLiveToken({
      userId,
      workspaceId,
      source: 'jira',
    });
    expect(live!.accessToken).toBe('jira_access_refreshed');
    expect(live!.refreshToken).toBe('jira_refresh_rotated');
    expect(live!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(live!.metadata).toMatchObject({ cloudId: 'cloud-1' });
  });

  it('returns null when the member has not connected Jira', async () => {
    const { userId, workspaceId } = await createUserWithWorkspace('unconnected@example.com');
    const conn = await jiraOAuthService.getFreshConnection({ userId, workspaceId });
    expect(conn).toBeNull();
  });
});
