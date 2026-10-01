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
const { GET, POST } = await import('@/app/api/auth/[...all]/route');
const { truncateAuthTables, truncateRateLimitCounters } = await import('../helpers/db');
const {
  AUTH,
  BASE,
  CLAUDE_CALLBACK,
  authorize,
  connect,
  consentQuery,
  location,
  pkce,
  register,
  registeredClientId,
  signedInCookie,
  token,
} = await import('../helpers/oauthFlow');
const { __resetSharedRateLimitStoreForTest } = await import('@/lib/rateLimit/store');
const { pinSharedRateLimitStoreDeadline } = await import('../helpers/rateLimitStore');
const { mcpResourceUrl } = await import('@/lib/oauth/config');
const { oauthAuthorizeNext } = await import('@/lib/oauth/authorizeReturn');
const { RATE_LIMIT_DISABLE_ENV } = await import('@/lib/rateLimit/limiter');
const { ALIGNED_HEADROOM_MS, ALIGNED_WINDOW_MS, waitForWindowHeadroom } =
  await import('../helpers/rateLimitWindow');

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

// ── helpers (the flow itself lives in tests/helpers/oauthFlow.ts) ───────────

/** Run a signed-in person through authorize + consent; return the code. The
 * consent is approved the way the consent page approves it — through
 * `oauthConnectionsService` (MOTIR-6983), which records the connection the code
 * is bound to. */
async function codeFor(clientId: string, verifierChallenge = pkce()): Promise<string> {
  return (await connect({ clientId, keys: verifierChallenge })).code;
}

// ── discovery lives in tests/oauth/wellKnownRoutes.test.ts ─────────────────

describe('dynamic client registration (RFC 7591)', () => {
  it("registers claude.ai's callback as a PUBLIC client", async () => {
    const res = await register([CLAUDE_CALLBACK]);
    // 201 Created, as RFC 7591 §3.2.1 specifies — 1.6.11 answered 200 (MOTIR-7171).
    expect(res.status).toBe(201);
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
      expect(res.status, uri).toBe(201);
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
    // Motir's own refused-request page (MOTIR-6985): the redirect is checked
    // before the resource, so the reason given is the untrusted redirect.
    expect(at.pathname).toBe('/oauth/error');
    expect(at.searchParams.get('error')).toBe('invalid_redirect');
  });
});

describe('consent is recorded only through the consent screen (MOTIR-6983)', () => {
  async function postConsent(cookie: string, body: Record<string, unknown>): Promise<Response> {
    return POST(
      new Request(`${AUTH}/oauth2/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: BASE },
        body: JSON.stringify(body),
      }),
    );
  }

  it('refuses an ACCEPTING consent posted straight to the provider — it would bind no connection', async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    const oauthQuery = await consentQuery(clientId, cookie);
    const res = await postConsent(cookie, { accept: true, oauth_query: oauthQuery });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('access_denied');
    expect(await db.oauthConsent.count()).toBe(0);
    expect(
      await db.verification.count({ where: { value: { contains: 'authorization_code' } } }),
    ).toBe(0);
  });

  it('still lets a person DECLINE directly: back to the client with access_denied, nothing stored', async () => {
    const clientId = await registeredClientId();
    const cookie = await signedInCookie();
    const oauthQuery = await consentQuery(clientId, cookie);
    const res = await postConsent(cookie, { accept: false, oauth_query: oauthQuery });
    expect(res.status, await res.clone().text()).toBe(200);
    const back = new URL(((await res.json()) as { url: string }).url);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(await db.oauthConsent.count()).toBe(0);
  });

  it('asks again on every authorization — a remembered consent never skips the workspace choice', async () => {
    const clientId = await registeredClientId();
    const connected = await connect({ clientId });
    expect(await db.oauthConsent.count()).toBe(1);
    const again = location(await authorize({ clientId }, connected.cookie));
    expect(again.pathname).toBe('/oauth/consent');
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
    // RFC 8707 §2's own code: better-auth 1.7 answers a foreign resource with
    // invalid_target (1.6 said invalid_request).
    expect(((await res.json()) as { error: string }).error).toBe('invalid_target');
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
    expect((await register([CLAUDE_CALLBACK], ip)).status).toBe(201);
    expect((await register([CLAUDE_CALLBACK], ip)).status).toBe(201);
    const refused = await register([CLAUDE_CALLBACK], ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    // Another origin is not charged for it.
    expect((await register([CLAUDE_CALLBACK], '203.0.113.78')).status).toBe(201);
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
