import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { withV1Route, REQUEST_ID_HEADER, API_VERSION_HEADER } from '@/lib/api/v1/route';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import { ApiV1Error, InvalidRequestError } from '@/lib/api/v1/errors';
import { presentedBearerToken, tokenFingerprint } from '@/lib/api/v1/bearer';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { createV1Caller, bearer } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { ALIGNED_WINDOW_MS, waitForWindowBoundary } from '../../helpers/rateLimitWindow';

// The shared `/api/v1` route wrapper (Story 11.1 · Subtask 11.1.2 —
// MOTIR-1858). Real Postgres, real PATs minted through the shipped service —
// nothing about auth is mocked, because the wrapper's whole job is to compose
// the shipped gate correctly.
//
// Most cases drive a FIXTURE route rather than `/api/v1/me`, which is the
// point: the acceptance criteria require the wrapper to COMPOSE — a second
// route must adopt it without copying auth or error-mapping logic. A fixture
// route proves that in a way testing only `/me` cannot.

const BASE = 'http://localhost:3000/api/v1/fixture';

/** The minimal route a v1 endpoint can be: declare a scope, return a body. */
const fixtureRoute = withV1Route({ scope: 'read' }, async (ctx) =>
  NextResponse.json({ userId: ctx.userId, workspaceId: ctx.workspaceId }),
);

/** A route whose handler throws whatever the test needs thrown. */
function throwingRoute(thrown: unknown) {
  return withV1Route({ scope: 'read' }, async () => {
    throw thrown;
  });
}

function req(headers: Record<string, string> = {}, url = BASE) {
  return new Request(url, { headers });
}

describe('withV1Route — authentication', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('admits a valid token carrying the required scope', async () => {
    const caller = await createV1Caller({ scopes: ['read'] });

    const res = await fixtureRoute(req(caller.headers));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      userId: caller.user.id,
      workspaceId: caller.workspace.id,
    });
  });

  // The non-disclosure property, asserted as FIVE cases against ONE shared
  // expectation. Written this way on purpose: a future "helpful" error message
  // that distinguished, say, expired from revoked would turn the endpoint into
  // a token oracle, and it must fail HERE rather than pass five bespoke
  // assertions that were each updated to match.
  it('returns an INDISTINGUISHABLE 401 for missing / malformed / unknown / revoked / expired tokens', async () => {
    const caller = await createV1Caller();

    // revoked — a real token, then revoked through the shipped service
    const revoked = await createV1Caller();
    await apiTokensService.revoke(revoked.user.id, revoked.tokenId);

    // expired — minted with an expiry already in the past
    const expiring = await apiTokensService.create(caller.user.id, caller.workspace.id, {
      label: 'expired',
      scopes: ['read'],
      expiresAt: new Date(Date.now() - 60_000),
    });

    const cases: Array<[string, Record<string, string>]> = [
      ['missing', {}],
      ['malformed', { authorization: 'Basic bm90LWEtYmVhcmVy' }],
      ['unknown', bearer('motir_pat_thisdoesnotexistanywhereatall')],
      ['revoked', revoked.headers],
      ['expired', bearer(expiring.token)],
    ];

    const seen: Array<{ label: string; status: number; body: unknown }> = [];
    for (const [label, headers] of cases) {
      const res = await fixtureRoute(req(headers));
      seen.push({ label, status: res.status, body: await res.json() });
    }

    const expected = { code: 'UNAUTHENTICATED', error: 'Authentication required.' };
    for (const { label, status, body } of seen) {
      expect(status, `${label} must be 401`).toBe(401);
      expect(body, `${label} must not be distinguishable`).toEqual(expected);
    }
    // …and byte-identically to each other, not merely to a shared shape.
    const rendered = new Set(seen.map((s) => JSON.stringify(s.body)));
    expect(rendered.size).toBe(1);
  });

  it('returns 403 — not 401, and never an empty 200 — when the token lacks the scope', async () => {
    // A token with a real scope that is NOT the one the route declares.
    const caller = await createV1Caller({ scopes: ['work_items:write'] });

    const res = await fixtureRoute(req(caller.headers));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      code: 'INSUFFICIENT_SCOPE',
      error: "This token lacks the 'read' scope required for this operation.",
    });
  });

  it('runs auth BEFORE the handler — an unauthenticated request never reaches it', async () => {
    let handlerRan = false;
    const route = withV1Route({ scope: 'read' }, async () => {
      handlerRan = true;
      return NextResponse.json({ ok: true });
    });

    const res = await route(req());

    expect(res.status).toBe(401);
    expect(handlerRan).toBe(false);
  });
});

describe('withV1Route — error mapping', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('maps an ApiV1Error to its own status and { code, error }', async () => {
    const caller = await createV1Caller();
    const route = throwingRoute(new InvalidRequestError('INVALID_LIMIT', 'limit must be 1..100.'));

    const res = await route(req(caller.headers));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      code: 'INVALID_LIMIT',
      error: 'limit must be 1..100.',
    });
  });

  it('maps a typed DOMAIN error by its code — cross-tenant is 404, never 403', async () => {
    const caller = await createV1Caller();
    // The shape every `lib/<domain>/errors.ts` class has: a stable `code`.
    const notAMember = Object.assign(new Error('You are not a member of this workspace.'), {
      code: 'NOT_A_MEMBER',
    });
    const route = throwingRoute(notAMember);

    const res = await route(req(caller.headers));

    // 404, not 403: a 403 would confirm the resource EXISTS — an existence
    // oracle over another tenant's data.
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NOT_A_MEMBER',
      error: 'You are not a member of this workspace.',
    });
  });

  it('turns an UNRECOGNISED error into a 500 that leaks no code, message or stack', async () => {
    const caller = await createV1Caller();
    const raw = new Error(
      'Invalid `db.workItem.findUnique()` invocation: connection refused at 10.0.0.4:5432',
    );
    const route = throwingRoute(raw);

    const res = await route(req(caller.headers));
    const body = await res.json();
    const serialised = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error.' });
    expect(body).not.toHaveProperty('code');
    expect(serialised).not.toContain('db.workItem');
    expect(serialised).not.toContain('5432');
    expect(serialised).not.toContain('at ');
  });

  it('does NOT render a domain error whose code is not in the v1 map', async () => {
    const caller = await createV1Caller();
    const unlisted = Object.assign(new Error('Internal invariant violated: shard 7 missing.'), {
      code: 'SHARD_MISSING',
    });

    const res = await throwingRoute(unlisted)(req(caller.headers));

    // An error reaching a client is part of the public contract; an unlisted
    // code must never appear by accident.
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error.' });
  });
});

describe('withV1Route — request id', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('stamps a request id on a success, a mapped error AND a 500', async () => {
    const caller = await createV1Caller();

    const ok = await fixtureRoute(req(caller.headers));
    const mapped = await throwingRoute(new ApiV1Error('NOPE', 418, 'no'))(req(caller.headers));
    const boom = await throwingRoute(new Error('boom'))(req(caller.headers));
    const unauth = await fixtureRoute(req());

    for (const [label, res] of [
      ['200', ok],
      ['mapped error', mapped],
      ['500', boom],
      ['401', unauth],
    ] as const) {
      expect(res.headers.get(REQUEST_ID_HEADER), `${label} carries a request id`).toBeTruthy();
    }
  });

  it('does NOT let a client dictate the api version the way it can the request id', async () => {
    // The request id is echoed by design; the contract version is a fact about
    // the SERVER and must never be reflected back from the request, or a client
    // could convince itself it is talking to a contract that does not exist.
    const caller = await createV1Caller();

    const res = await fixtureRoute(req({ ...caller.headers, [API_VERSION_HEADER]: '9.9.9' }));

    expect(res.headers.get(API_VERSION_HEADER)).toBe(V1_CONTRACT_VERSION);
  });

  it('echoes an id-shaped client request id, and mints one otherwise', async () => {
    const caller = await createV1Caller();

    const echoed = await fixtureRoute(
      req({ ...caller.headers, [REQUEST_ID_HEADER]: 'client-abc_123.4' }),
    );
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe('client-abc_123.4');

    // A header that is not id-shaped is NOT reflected back.
    const rejected = await fixtureRoute(
      req({ ...caller.headers, [REQUEST_ID_HEADER]: '<script>alert(1)</script>' }),
    );
    const minted = rejected.headers.get(REQUEST_ID_HEADER);
    expect(minted).toBeTruthy();
    expect(minted).not.toContain('<script>');
  });
});

describe('withV1Route — the contract version header (MOTIR-2275)', () => {
  const savedEnv = {
    limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
    window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
  };

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });

  afterEach(() => {
    if (savedEnv.limit === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT'];
    else process.env['MOTIR_API_V1_RATE_LIMIT'] = savedEnv.limit;
    if (savedEnv.window === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];
    else process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = savedEnv.window;
    resetRateLimitStore();
  });

  // The criterion the card is FOR: every exit path, driving the REAL wrapper
  // rather than a fixture that re-states what the wrapper is assumed to do.
  // A version a client can only read on a 200 is useless precisely when it
  // matters — a 401/403/429/500 is when it most wants to know whether it is
  // speaking the right contract at all.
  it('stamps the version on a 200, a 401, a 403, a mapped domain error and a 500', async () => {
    const caller = await createV1Caller({ scopes: ['read'] });
    const wrongScope = await createV1Caller({ scopes: ['work_items:write'] });
    const notAMember = Object.assign(new Error('You are not a member of this workspace.'), {
      code: 'NOT_A_MEMBER',
    });

    const cases: Array<[string, number, Response]> = [
      ['200', 200, await fixtureRoute(req(caller.headers))],
      ['401', 401, await fixtureRoute(req())],
      ['403', 403, await fixtureRoute(req(wrongScope.headers))],
      ['422 mapped', 422, await throwingRoute(new InvalidRequestError('INVALID_LIMIT', 'no.'))(req(caller.headers))], // prettier-ignore
      ['404 domain', 404, await throwingRoute(notAMember)(req(caller.headers))],
      ['500', 500, await throwingRoute(new Error('boom'))(req(caller.headers))],
    ];

    for (const [label, status, res] of cases) {
      expect(res.status, `${label} status`).toBe(status);
      // Read FROM the constant, never restated — a bump must not need this
      // assertion edited, and a hard-coded '1.0.0' here would pass while the
      // header lied.
      expect(res.headers.get(API_VERSION_HEADER), `${label} carries the version`).toBe(
        V1_CONTRACT_VERSION,
      );
    }
  });

  // The 429 is its own case: it is the ONE exit the wrapper takes before the
  // scope check, from inside the try block, so a version stamped anywhere but
  // before the try could plausibly still cover the five above and miss this one.
  it('stamps the version on a 429 — the exit taken before the scope check', async () => {
    process.env['MOTIR_API_V1_RATE_LIMIT'] = '1';
    process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    const caller = await createV1Caller({ scopes: ['read'] });
    // Two requests whose outcome depends on the ACCUMULATED count, so the run
    // must own a whole window (`tests/helpers/rateLimitWindow.ts`).
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);

    const served = await fixtureRoute(req(caller.headers));
    const refused = await fixtureRoute(req(caller.headers));

    expect(served.status).toBe(200);
    expect(refused.status).toBe(429);
    expect(refused.headers.get(API_VERSION_HEADER)).toBe(V1_CONTRACT_VERSION);
  });

  it('matches the version the emitted document publishes as `info.version`', async () => {
    // One number with one meaning (ADR Amendment 4 Q6): the header and the
    // document cannot disagree, because a client compares one against the other.
    const caller = await createV1Caller({ scopes: ['read'] });
    const { emitOpenApiDocument } = await import('@/lib/api/v1/openapi/emit');
    const document = emitOpenApiDocument() as unknown as { info: { version: string } };

    const res = await fixtureRoute(req(caller.headers));

    expect(res.headers.get(API_VERSION_HEADER)).toBe(document.info.version);
  });
});

describe('withV1Route — composition and route params', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('resolves dynamic route params and hands the handler a ServiceContext', async () => {
    const caller = await createV1Caller();
    const route = withV1Route<{ id: string }>({ scope: 'read' }, async (ctx) =>
      NextResponse.json({ id: ctx.params.id, service: ctx.service }),
    );

    const res = await route(req(caller.headers, `${BASE}/MOTIR-42`), {
      params: Promise.resolve({ id: 'MOTIR-42' }),
    });

    await expect(res.json()).resolves.toEqual({
      id: 'MOTIR-42',
      service: { userId: caller.user.id, workspaceId: caller.workspace.id },
    });
  });

  it('lets a handler contribute headers that survive an error path', async () => {
    const caller = await createV1Caller();
    // The seam MOTIR-1860's rate-limit headers use: stamped into
    // `responseHeaders`, they must appear even when the handler then throws.
    const route = withV1Route({ scope: 'read' }, async (ctx) => {
      ctx.responseHeaders.set('x-fixture-header', 'kept');
      throw new Error('boom');
    });

    const res = await route(req(caller.headers));

    expect(res.status).toBe(500);
    expect(res.headers.get('x-fixture-header')).toBe('kept');
  });
});

describe('presented bearer credential', () => {
  it('reads the bearer secret, case-insensitively on the scheme', () => {
    expect(presentedBearerToken(req({ authorization: 'Bearer motir_pat_abc' }))).toBe(
      'motir_pat_abc',
    );
    expect(presentedBearerToken(req({ authorization: 'bearer motir_pat_abc' }))).toBe(
      'motir_pat_abc',
    );
  });

  it('is undefined for an absent, non-bearer or empty credential', () => {
    expect(presentedBearerToken(req())).toBeUndefined();
    expect(presentedBearerToken(req({ authorization: 'Basic abc' }))).toBeUndefined();
    expect(presentedBearerToken(req({ authorization: 'Bearer   ' }))).toBeUndefined();
  });

  it('fingerprints a token stably, without carrying the secret', () => {
    const fp = tokenFingerprint('motir_pat_abc');

    expect(fp).toBe(tokenFingerprint('motir_pat_abc'));
    expect(fp).not.toBe(tokenFingerprint('motir_pat_abd'));
    expect(fp).not.toContain('motir_pat_');
  });
});
