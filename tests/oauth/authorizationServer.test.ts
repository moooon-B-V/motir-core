import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OAuth authorization server, end to end against the real database
// (Story MOTIR-6973 · Subtask MOTIR-6982): registration → authorize → consent →
// code → token → refresh → revoke, through the SAME catch-all route the app
// serves, plus every refusal the card names.
//
// Better-Auth's own limiter is switched off the way every auth suite switches it
// off (the opt-in flag, hoisted before the auth module freezes its config): a run
// signs in several times from one IP-less caller. The app-level limiter under
// test here is a different one, on the shared counter, and is asserted below.
vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const { db } = await import('@/lib/db');
const { auth } = await import('@/lib/auth');
const { GET, POST } = await import('@/app/api/auth/[...all]/route');
const { truncateAuthTables, truncateRateLimitCounters } = await import('../helpers/db');
const { createTestUser, TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { __resetSharedRateLimitStoreForTest } = await import('@/lib/rateLimit/store');
const { pinSharedRateLimitStoreDeadline } = await import('../helpers/rateLimitStore');
const { mcpResourceUrl } = await import('@/lib/oauth/config');
const { oauthAuthorizeNext } = await import('@/lib/oauth/authorizeReturn');
const { RATE_LIMIT_DISABLE_ENV } = await import('@/lib/rateLimit/limiter');
const { ALIGNED_HEADROOM_MS, ALIGNED_WINDOW_MS, waitForWindowHeadroom } =
  await import('../helpers/rateLimitWindow');

const BASE = 'http://localhost:3000';
const AUTH = `${BASE}/api/auth`;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  delete process.env['MOTIR_OAUTH_REGISTER_RATE_LIMIT'];
  delete process.env['MOTIR_OAUTH_TOKEN_RATE_LIMIT'];
});

afterAll(async () => {
  __resetSharedRateLimitStoreForTest();
  await db.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

let ipCounter = 0;
/** A distinct client IP per request, so the shared limiter never couples cases. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

async function register(redirectUris: string[], ip = freshIp()): Promise<Response> {
  return POST(
    new Request(`${AUTH}/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
  );
}

async function registeredClientId(redirectUri = CLAUDE_CALLBACK): Promise<string> {
  const res = await register([redirectUri]);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface AuthorizeParams {
  clientId: string;
  redirectUri?: string;
  challenge?: string | null;
  method?: string | null;
  resource?: string | null;
  scope?: string;
}

function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri ?? CLAUDE_CALLBACK,
    state: 'st-123',
  });
  if (p.challenge !== null) q.set('code_challenge', p.challenge ?? pkce().challenge);
  if (p.method !== null) q.set('code_challenge_method', p.method ?? 'S256');
  if (p.resource !== null) q.set('resource', p.resource ?? mcpResourceUrl());
  if (p.scope) q.set('scope', p.scope);
  return `${AUTH}/oauth2/authorize?${q.toString()}`;
}

async function authorize(p: AuthorizeParams, cookie?: string): Promise<Response> {
  return GET(new Request(authorizeUrl(p), { headers: cookie ? { cookie } : {} }));
}

function location(res: Response): URL {
  const at = res.headers.get('location');
  expect(at, `expected a redirect, got ${res.status}`).toBeTruthy();
  return new URL(at!, BASE);
}

async function signedInCookie(): Promise<string> {
  const user = await createTestUser();
  const res = await auth.api.signInEmail({
    body: { email: user.email, password: TEST_PASSWORD },
    headers: new Headers({ origin: BASE }),
    asResponse: true,
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function token(form: Record<string, string>, ip = freshIp()): Promise<Response> {
  return POST(
    new Request(`${AUTH}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

/** Run a signed-in person through authorize + consent; return the code. */
async function codeFor(clientId: string, verifierChallenge = pkce()): Promise<string> {
  const cookie = await signedInCookie();
  const res = await authorize(
    { clientId, challenge: verifierChallenge.challenge, scope: 'offline_access' },
    cookie,
  );
  const consent = location(res);
  expect(consent.pathname).toBe('/oauth/consent');
  const accepted = await POST(
    new Request(`${AUTH}/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ accept: true, oauth_query: consent.searchParams.toString() }),
    }),
  );
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const { url } = (await accepted.json()) as { url: string };
  const back = new URL(url);
  expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
  expect(back.searchParams.get('state')).toBe('st-123');
  const code = back.searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

// ── discovery lives in tests/oauth/wellKnownRoutes.test.ts ─────────────────

describe('dynamic client registration (RFC 7591)', () => {
  it("registers claude.ai's callback as a PUBLIC client", async () => {
    const res = await register([CLAUDE_CALLBACK]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['client_id']).toEqual(expect.any(String));
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(body['client_secret']).toBeUndefined();
    expect(body['redirect_uris']).toEqual([CLAUDE_CALLBACK]);
  });

  it('registers a loopback callback (a native client on an ephemeral port)', async () => {
    for (const uri of [
      'http://127.0.0.1:53682/callback',
      'http://localhost:33418/callback',
      'http://[::1]:8080/cb',
    ]) {
      const res = await register([uri]);
      expect(res.status, uri).toBe(200);
    }
  });

  it('refuses plain http on a public host, and a custom scheme, with invalid_redirect_uri', async () => {
    for (const uri of ['http://example.com/cb', 'myapp://callback', 'javascript:alert(1)']) {
      const res = await register([CLAUDE_CALLBACK, uri]);
      expect(res.status, uri).toBe(400);
      expect(((await res.json()) as { error: string }).error, uri).toBe('invalid_redirect_uri');
    }
    expect(await db.oauthClient.count()).toBe(0);
  });
});

describe('the authorize endpoint', () => {
  it("sends a signed-in person's valid request to /oauth/consent, carrying the request", async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    const { challenge } = pkce();
    const res = await authorize({ clientId, challenge }, cookie);
    const at = location(res);
    expect(at.pathname).toBe('/oauth/consent');
    expect(at.searchParams.get('client_id')).toBe(clientId);
    expect(at.searchParams.get('code_challenge')).toBe(challenge);
    expect(at.searchParams.get('state')).toBe('st-123');
    expect(at.searchParams.get('sig')).toBeTruthy();
  });

  it('sends a signed-out person through /sign-in, and back to the request after', async () => {
    const clientId = await registeredClientId();
    const at = location(await authorize({ clientId }));
    expect(at.pathname).toBe('/sign-in');
    expect(at.searchParams.get('client_id')).toBe(clientId);

    // What the sign-in page turns that arrival into (`app/(auth)/sign-in/page.tsx`):
    // a `next` pointing at the authorize endpoint. Followed with the session the
    // sign-in produced, it continues to consent — `resource` intact.
    const next = oauthAuthorizeNext(at.searchParams);
    expect(next).toMatch(/^\/api\/auth\/oauth2\/authorize\?/);
    const cookie = await signedInCookie();
    const resumed = location(await GET(new Request(`${BASE}${next}`, { headers: { cookie } })));
    expect(resumed.pathname).toBe('/oauth/consent');
    expect(resumed.searchParams.get('client_id')).toBe(clientId);
  });

  it('matches a loopback redirect port-agnostically (RFC 8252 §7.3), for IP and localhost', async () => {
    const cookie = await signedInCookie();
    for (const [registered, requested] of [
      ['http://127.0.0.1:53682/callback', 'http://127.0.0.1:61000/callback'],
      ['http://localhost:33418/callback', 'http://localhost:45123/callback'],
    ] as const) {
      const clientId = await registeredClientId(registered);
      const at = location(await authorize({ clientId, redirectUri: requested }, cookie));
      expect(at.pathname, requested).toBe('/oauth/consent');
    }
  });

  it('refuses a loopback redirect whose PATH differs — only the port is free', async () => {
    const cookie = await signedInCookie();
    const clientId = await registeredClientId('http://127.0.0.1:53682/callback');
    const at = location(
      await authorize({ clientId, redirectUri: 'http://127.0.0.1:53682/elsewhere' }, cookie),
    );
    expect(at.pathname).not.toBe('/oauth/consent');
    expect(at.searchParams.get('error')).toBe('invalid_redirect');
  });

  it('refuses a request with no code_challenge, back to the client with invalid_request', async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    const at = location(await authorize({ clientId, challenge: null, method: null }, cookie));
    expect(`${at.origin}${at.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(at.searchParams.get('error')).toBe('invalid_request');
    expect(at.searchParams.get('state')).toBe('st-123');
  });

  it('refuses code_challenge_method=plain and never reaches consent', async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    const res = await authorize({ clientId, method: 'plain' }, cookie);
    const at = res.headers.get('location');
    expect(at ?? '').not.toContain('/oauth/consent');
    expect(res.status).toBeGreaterThanOrEqual(300);
    if (at) expect(new URL(at, BASE).searchParams.get('error')).toBe('invalid_request');
    else expect(res.status).toBe(400);
  });

  it('refuses a missing resource with invalid_target (RFC 8707), back to the client', async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    const at = location(await authorize({ clientId, resource: null }, cookie));
    expect(`${at.origin}${at.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(at.searchParams.get('error')).toBe('invalid_target');
    expect(at.searchParams.get('state')).toBe('st-123');
    expect(at.searchParams.get('iss')).toBe(AUTH);
  });

  it('refuses a resource other than the MCP with invalid_target', async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    for (const resource of [`${BASE}/api/v1`, 'https://evil.example/api/mcp']) {
      const at = location(await authorize({ clientId, resource }, cookie));
      expect(at.searchParams.get('error'), resource).toBe('invalid_target');
      expect(at.pathname).not.toBe('/oauth/consent');
    }
  });

  it('never follows an UNREGISTERED redirect with the resource error — it goes to the error page', async () => {
    const clientId = await registeredClientId();
    const at = location(
      await authorize({ clientId, resource: null, redirectUri: 'https://attacker.example/cb' }),
    );
    expect(at.host).not.toBe('attacker.example');
    expect(at.pathname).toBe('/api/auth/error');
    expect(at.searchParams.get('error')).toBe('invalid_target');
  });
});

describe('tokens: exchange, refresh and revoke', () => {
  it('exchanges a code for an opaque access token and a refresh token, bound to the MCP', async () => {
    const clientId = await registeredClientId();
    const keys = pkce();
    const code = await codeFor(clientId, keys);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: keys.verifier,
      resource: mcpResourceUrl(),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    expect(body['access_token']).toEqual(expect.any(String));
    expect(body['refresh_token']).toEqual(expect.any(String));
    expect(body['id_token']).toBeUndefined();
    // Opaque — not a JWT — and stored hashed, never as the value handed out.
    expect(String(body['access_token']).split('.')).toHaveLength(1);
    const rows = await db.oauthAccessToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).not.toBe(body['access_token']);
  });

  it('refuses the exchange with the wrong code_verifier (PKCE)', async () => {
    const clientId = await registeredClientId();
    const code = await codeFor(clientId);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: pkce().verifier,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.oauthAccessToken.count()).toBe(0);
  });

  it('refuses a token for a resource other than the MCP', async () => {
    const clientId = await registeredClientId();
    const keys = pkce();
    const code = await codeFor(clientId, keys);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_CALLBACK,
      client_id: clientId,
      code_verifier: keys.verifier,
      resource: `${BASE}/api/v1`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('refreshes, then revokes (RFC 7009) so the refresh token is dead', async () => {
    const clientId = await registeredClientId();
    const keys = pkce();
    const code = await codeFor(clientId, keys);
    const first = (await (
      await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: keys.verifier,
        resource: mcpResourceUrl(),
      })
    ).json()) as { access_token: string; refresh_token: string };

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
      resource: mcpResourceUrl(),
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(second.access_token).not.toBe(first.access_token);

    const revoked = await POST(
      new Request(`${AUTH}/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: second.refresh_token,
          token_type_hint: 'refresh_token',
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);

    const after = await token({
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token,
      client_id: clientId,
    });
    expect(after.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the app-level limiter on registration and token (per IP)', () => {
  // The same flag also switches the SHARED limiter off, and it is read per call
  // — so these cases clear it (Better-Auth's own limiter froze it at import and
  // stays off), pin the windows, and align to one window cell as
  // `tests/rateLimit/surfaceGuards.test.ts` does.
  const WINDOWS = [
    'MOTIR_OAUTH_REGISTER_RATE_LIMIT_WINDOW_MS',
    'MOTIR_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS',
  ];
  beforeEach(async () => {
    delete process.env[RATE_LIMIT_DISABLE_ENV];
    for (const name of WINDOWS) process.env[name] = String(ALIGNED_WINDOW_MS);
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
  });
  afterEach(() => {
    process.env[RATE_LIMIT_DISABLE_ENV] = '1';
    for (const name of WINDOWS) delete process.env[name];
  });

  it('refuses the (N+1)-th registration from one IP with a 429', async () => {
    process.env['MOTIR_OAUTH_REGISTER_RATE_LIMIT'] = '2';
    const ip = '203.0.113.77';
    expect((await register([CLAUDE_CALLBACK], ip)).status).toBe(200);
    expect((await register([CLAUDE_CALLBACK], ip)).status).toBe(200);
    const refused = await register([CLAUDE_CALLBACK], ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    // Another origin is not charged for it.
    expect((await register([CLAUDE_CALLBACK], '203.0.113.78')).status).toBe(200);
  });

  it('refuses the (N+1)-th token request from one IP with a 429', async () => {
    process.env['MOTIR_OAUTH_TOKEN_RATE_LIMIT'] = '2';
    const ip = '203.0.113.90';
    const bogus = { grant_type: 'refresh_token', refresh_token: 'nope', client_id: 'nope' };
    expect((await token(bogus, ip)).status).not.toBe(429);
    expect((await token(bogus, ip)).status).not.toBe(429);
    expect((await token(bogus, ip)).status).toBe(429);
  });
});
