import { beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { withV1Route, REQUEST_ID_HEADER } from '@/lib/api/v1/route';
import { ApiV1Error, InvalidRequestError } from '@/lib/api/v1/errors';
import { presentedBearerToken, tokenFingerprint } from '@/lib/api/v1/bearer';
import { createV1Caller, bearer } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

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
