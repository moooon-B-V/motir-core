import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import enMessages from '@/messages/en.json';

// The OAuth CONSENT screen (Story MOTIR-6973 · Subtask MOTIR-6985), against the
// real database, the real provider and the real routes:
//
//   * the route SMOKE test — `/oauth/consent` with a valid pending request
//     renders the app, the redirect host, the workspace and Approve;
//   * Approve (all projects, and one project with a narrowed grant) records the
//     connection and returns the client redirect with the code and the state;
//   * Deny returns `error=access_denied` with the state and writes nothing;
//   * a forged or expired request renders the refused page and redirects nowhere;
//   * a signed-out visit goes to sign-in with the AUTHORIZE request in `next`;
//   * an unknown client or unregistered redirect is refused on Motir's own page.
//
// Two module mocks, both the conventional ones: `getSession` (the test has no
// cookie jar for `next/headers`) and the route's compliant-session gate. The
// provider still reads the REAL session from the forwarded cookie.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const getSession = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
const requireCompliantSession = vi.fn();
const workspaceContext = vi.fn(async (): Promise<unknown> => null);

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: () => getSession(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: () => requireCompliantSession(),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: () => workspaceContext(),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { createTestUser } = await import('../fixtures/userFixtures');
const { DEFAULT_TOKEN_GRANT } = await import('@/lib/tokens/grant');
const { oauthConnectionsService } = await import('@/lib/services/oauthConnectionsService');
const ConsentPage = (await import('@/app/(auth)/oauth/consent/page')).default;
const ErrorPage = (await import('@/app/(auth)/oauth/error/page')).default;
const consentRoute = await import('@/app/api/oauth/consent/route');
const {
  AUTH,
  BASE,
  CLAUDE_CALLBACK,
  authorize,
  consentQuery,
  exchange,
  location,
  pkce,
  registeredClientId,
  signIn,
} = await import('../helpers/oauthFlow');

beforeEach(async () => {
  await truncateAuthTables();
  getSession.mockReset();
  redirect.mockClear();
  requireCompliantSession.mockReset();
  workspaceContext.mockReset().mockResolvedValue(null);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

function html(element: ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {element}
    </NextIntlClientProvider>,
  );
}

function asSearchParams(query: string): Promise<Record<string, string>> {
  return Promise.resolve(Object.fromEntries(new URLSearchParams(query)));
}

/** A signed-in person with a workspace and a project, and a pending request. */
async function pending(keys = pkce()) {
  const fx = await makeWorkItemFixture();
  const clientId = await registeredClientId();
  const { cookie, user } = await signIn(fx.owner);
  const query = await consentQuery(clientId, cookie, keys.challenge);
  getSession.mockResolvedValue({ user, session: { id: 's' } });
  requireCompliantSession.mockResolvedValue({ ok: true, session: { user } });
  return { fx, clientId, cookie, user, query, keys };
}

async function post(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return consentRoute.POST(
    new Request(`${BASE}/api/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify(body),
    }),
  );
}

async function connectionsOf(userId: string) {
  return adminDb.apiToken.findMany({ where: { userId, oauthClientId: { not: null } } });
}

// ── the smoke test ─────────────────────────────────────────────────────────

describe('/oauth/consent renders a valid pending request', () => {
  it('shows the app, unverified, its return host, the workspace, the grant and Approve', async () => {
    const { query, fx } = await pending();
    const page = html(await ConsentPage({ searchParams: asSearchParams(query) }));

    expect(page).toContain('Connect Claude to Motir?');
    expect(page).toContain('Unverified');
    expect(page).toContain('claude.ai');
    expect(page).toContain(`You’ll be sent to ${CLAUDE_CALLBACK}`);
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    expect(page).toContain(workspace.name);
    expect(page).toContain('All projects');
    expect(page).toContain('What it can do');
    expect(page).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Approve and connect/);
    expect(page).toContain('Deny');
  });

  it('describes the request from the SIGNED request and the registration, not the URL', async () => {
    const { query, user } = await pending();
    const request = await oauthConnectionsService.describeConsentRequest(user.id, query);
    expect(request.client).toMatchObject({ name: 'Claude', unverified: true });
    expect(request.redirectUri).toBe(CLAUDE_CALLBACK);
    expect(request.redirectHost).toBe('claude.ai');
    expect(request.loopback).toBe(false);
    expect(request.workspaces).toHaveLength(1);

    // A tampered query no longer verifies — and the page says so, redirecting nowhere.
    const forged = new URLSearchParams(query);
    forged.set('redirect_uri', 'https://attacker.example/cb');
    const page = html(await ConsentPage({ searchParams: asSearchParams(forged.toString()) }));
    expect(page).toContain('This connection request can’t be used');
    expect(page).not.toContain('Approve and connect');
    expect(page).not.toContain('attacker.example');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders the refused page for an EXPIRED request, and does not redirect', async () => {
    const { query } = await pending();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    try {
      const page = html(await ConsentPage({ searchParams: asSearchParams(query) }));
      expect(page).toContain('It is too old to use');
      expect(page).not.toContain('Approve and connect');
      expect(redirect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a person in no workspace sees the no-workspace state with Deny only', async () => {
    const clientId = await registeredClientId();
    const loner = await createTestUser();
    const { cookie, user } = await signIn(loner);
    const query = await consentQuery(clientId, cookie);
    getSession.mockResolvedValue({ user, session: { id: 's' } });

    const page = html(await ConsentPage({ searchParams: asSearchParams(query) }));
    expect(page).toContain('Claude can’t connect yet');
    expect(page).toContain('Deny and return to Claude');
    expect(page).not.toContain('Approve and connect');
  });

  it('a signed-out visit goes through sign-in and returns to the SAME authorize request', async () => {
    const { query } = await pending();
    getSession.mockResolvedValue(null);
    await expect(ConsentPage({ searchParams: asSearchParams(query) })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    const to = new URL(redirect.mock.calls[0]![0], BASE);
    expect(to.pathname).toBe('/sign-in');
    const next = new URL(to.searchParams.get('next')!, BASE);
    expect(`${next.origin}${next.pathname}`).toBe(`${AUTH}/oauth2/authorize`);
    const original = new URLSearchParams(query);
    for (const name of ['client_id', 'redirect_uri', 'state', 'code_challenge']) {
      expect(next.searchParams.get(name), name).toBe(original.get(name));
    }
    expect(next.searchParams.has('sig')).toBe(false);
  });
});

// ── approve / deny ─────────────────────────────────────────────────────────

describe('POST /api/oauth/consent', () => {
  it('Approve with all projects records DEFAULT_TOKEN_GRANT and returns the code with the state', async () => {
    const { query, cookie, user, fx, clientId, keys } = await pending();
    const res = await post(cookie, {
      action: 'approve',
      oauthQuery: query,
      workspaceId: fx.workspaceId,
      projectId: null,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { redirectUrl } = (await res.json()) as { redirectUrl: string };
    const back = new URL(redirectUrl);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('state')).toBe('st-123');
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const [connection] = await connectionsOf(user.id);
    expect(connection!.projectId).toBeNull();
    expect(connection!.scopes.filter((s) => !s.startsWith('_'))).toEqual(
      expect.arrayContaining([...DEFAULT_TOKEN_GRANT]),
    );
    // The code is real: it exchanges for tokens.
    const tokens = await exchange(clientId, code, keys.verifier);
    expect(tokens.access_token).toBeTruthy();
  });

  it('Approve with one project records exactly the narrowed grant', async () => {
    const { query, cookie, user, fx } = await pending();
    const res = await post(cookie, {
      action: 'approve',
      oauthQuery: query,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      permissions: ['project:browse', 'comment:add'],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [connection] = await connectionsOf(user.id);
    expect(connection!.projectId).toBe(fx.projectId);
    expect(connection!.scopes.filter((s) => s.includes(':')).sort()).toEqual([
      'comment:add',
      'project:browse',
    ]);
  });

  it('Deny returns access_denied with the state, and no connection exists', async () => {
    const { query, cookie, user } = await pending();
    const res = await post(cookie, { action: 'deny', oauthQuery: query });
    expect(res.status, await res.clone().text()).toBe(200);
    const back = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('st-123');
    expect(await connectionsOf(user.id)).toHaveLength(0);
    expect(await adminDb.oauthConsent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses a forged request with its reason, and writes nothing', async () => {
    const { query, cookie, user, fx } = await pending();
    const forged = new URLSearchParams(query);
    forged.set('state', 'other');
    for (const action of ['approve', 'deny']) {
      const res = await post(cookie, {
        action,
        oauthQuery: forged.toString(),
        workspaceId: fx.workspaceId,
      });
      expect(res.status, action).toBe(400);
      expect(await res.json()).toEqual({
        code: 'OAUTH_CONSENT_REQUEST_INVALID',
        reason: 'not_issued',
      });
    }
    expect(await connectionsOf(user.id)).toHaveLength(0);
  });

  it('answers a workspace the person is not in with 404', async () => {
    const { query, cookie } = await pending();
    const other = await makeWorkItemFixture();
    const res = await post(cookie, {
      action: 'approve',
      oauthQuery: query,
      workspaceId: other.workspaceId,
    });
    expect(res.status).toBe(404);
  });
});

// ── the refused-request page ───────────────────────────────────────────────

describe('/oauth/error — a request that never reaches consent', () => {
  it('an unknown client is refused on Motir’s own page, not redirected', async () => {
    const cookie = (await signIn()).cookie;
    const at = location(await authorize({ clientId: 'no-such-client' }, cookie));
    expect(at.pathname).toBe('/oauth/error');
    expect(at.searchParams.get('error')).toBe('invalid_client');
    const page = html(
      await ErrorPage({ searchParams: Promise.resolve({ error: 'invalid_client' }) }),
    );
    expect(page).toContain('The app isn’t registered with Motir');
    expect(page).toContain('invalid_client');
  });

  it('an unregistered redirect names the host it asked for, and is not followed', async () => {
    const clientId = await registeredClientId();
    const cookie = (await signIn()).cookie;
    const at = location(
      await authorize({ clientId, redirectUri: 'https://attacker.example/cb' }, cookie),
    );
    expect(at.host).not.toBe('attacker.example');
    expect(at.pathname).toBe('/oauth/error');
    expect(at.searchParams.get('error')).toBe('invalid_redirect');
    expect(at.searchParams.get('host')).toBe('attacker.example');
    const page = html(
      await ErrorPage({
        searchParams: Promise.resolve({ error: 'invalid_redirect', host: 'attacker.example' }),
      }),
    );
    expect(page).toContain(
      'It asked to send you back to <strong class="font-semibold">attacker.example</strong>',
    );
  });
});

describe('/oauth/error — what it reads from its query', () => {
  it.each([
    [{ error: ['client_disabled', 'x'] }, 'The app isn’t registered with Motir'],
    [{ error: 'something_new' }, 'It wasn’t issued by Motir'],
    [{}, 'It wasn’t issued by Motir'],
    [{ error: 'invalid_redirect' }, 'an address it never registered with Motir'],
    [{ error: 'code_challenge' }, 'invalid_request · code_challenge'],
  ])('%j reads as a refusal it can name', async (searchParams, says) => {
    const page = html(await ErrorPage({ searchParams: Promise.resolve(searchParams) }));
    expect(page).toContain(says);
  });
});

describe('/oauth/consent — the page around the request', () => {
  it('a signed-out visit with no request to return to goes to plain sign-in', async () => {
    getSession.mockResolvedValue(null);
    await expect(ConsentPage({ searchParams: asSearchParams('') })).rejects.toThrow(
      'NEXT_REDIRECT /sign-in',
    );
  });

  it('reads a repeated query parameter the way the URL carries it', async () => {
    const { query } = await pending();
    const params: Record<string, string | string[]> = Object.fromEntries(
      new URLSearchParams(query),
    );
    params['extra'] = ['a', 'b'];
    // The signed query no longer matches, so the page refuses it — having read it.
    const page = html(await ConsentPage({ searchParams: Promise.resolve(params) }));
    expect(page).toContain('This connection request can’t be used');
  });

  it('lets an unexpected failure through rather than calling the request refused', async () => {
    const { query } = await pending();
    vi.spyOn(oauthConnectionsService, 'describeConsentRequest').mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(ConsentPage({ searchParams: asSearchParams(query) })).rejects.toThrow('db down');
  });

  it('opens on the workspace the person is working in', async () => {
    const { query, fx, user } = await pending();
    workspaceContext.mockResolvedValue({ userId: user.id, workspaceId: fx.workspaceId });
    const page = html(await ConsentPage({ searchParams: asSearchParams(query) }));
    expect(page).toContain('Approve and connect');
  });
});
