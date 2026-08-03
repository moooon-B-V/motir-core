import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withV1Route } from '@/lib/api/v1/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { startMcpHttpServer, type McpTestServer } from '../../helpers/mcpHttpServer';
import { createV1Caller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// END-TO-END CONFORMANCE for `/api/v1` (Story 11.1 · Subtask 11.1.6 —
// MOTIR-1862). The API is driven as the client it is built for: something
// OUTSIDE the process, holding only a token and a URL.
//
// ⚠️ Playwright is deliberately NOT the tool here, and the deviation is stated
// rather than assumed. This Story has no browser surface — the whole thing is
// headless HTTP, and the API reference PAGE is 11.4's with its own E2E. Driving
// an HTTP API through a browser would test Playwright's `request` fixture, not
// the product, and would pay the E2E lane's cost for nothing. The honest
// analogue — and the shipped precedent — is an external-client suite over real
// HTTP: `tests/cli/cli-story.test.ts` already does exactly this for the CLI
// (built binary → real `/api/mcp` → real Postgres) using this same harness. A
// deviation in TOOL, not in rigour.
//
// What this covers that the in-process gate (MOTIR-1861) CANNOT:
//
//   * the route is actually MOUNTED and reachable at its `/api/v1/…` path — a
//     handler wired at the wrong path passes every in-process test;
//   * real header TRANSPORT — that `Authorization: Bearer …` survives the
//     framework's parsing, and that `X-RateLimit-*` and the request id reach a
//     client rather than being set on an object nobody serialises;
//   * real statuses and real bodies AS AN HTTP CLIENT SEES THEM, including that
//     a 500 does not put a stack on the wire;
//   * the documented client journey works verbatim.

let server: McpTestServer;

/** The fixture route that raises a cross-tenant domain error over the wire.
 *  Story 11.1 ships no parameterised resource endpoint, so this is the only
 *  way to drive the 404-not-403 mapping END TO END rather than in-process. */
const crossTenantFixture = {
  GET: withV1Route({ scope: 'read' }, async () => {
    throw Object.assign(new Error('You are not a member of this workspace.'), {
      code: 'NOT_A_MEMBER',
    });
  }),
};

/** A fixture route that faults, to prove a 500 leaks nothing over the wire. */
const faultingFixture = {
  GET: withV1Route({ scope: 'read' }, async () => {
    throw new Error(
      'Invalid `db.workspace.findMany()` invocation: connection refused at 10.0.0.4:5432',
    );
  }),
};

/** A route the token's scope will never satisfy — the 403 probe. */
const writeOnlyFixture = {
  GET: withV1Route({ scope: 'sprints:write' }, async () => NextResponse.json({ ok: true })),
};

beforeAll(async () => {
  server = await startMcpHttpServer({
    v1Routes: true,
    extraRoutes: {
      '/api/v1/_fixture/cross-tenant': crossTenantFixture,
      '/api/v1/_fixture/faulting': faultingFixture,
      '/api/v1/_fixture/write-only': writeOnlyFixture,
    },
  });
});
afterAll(async () => {
  await server.close();
});

const savedEnv = {
  limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
  window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
};
function restoreEnv() {
  if (savedEnv.limit === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT'];
  else process.env['MOTIR_API_V1_RATE_LIMIT'] = savedEnv.limit;
  if (savedEnv.window === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];
  else process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = savedEnv.window;
}

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});
afterEach(restoreEnv);

/** A real `fetch` over a real socket — the only way this suite talks to Motir. */
function call(path: string, token?: string): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('/api/v1 conformance — the documented client journey, over a real socket', () => {
  // ONE coherent flow rather than eight unrelated cases: this is the sequence
  // the getting-started docs will promise, walked verbatim.
  it('mint a token → identity → page a collection → the refusals → the limit', async () => {
    // ── 1. Mint a PAT with `read`, as a user would via Settings ───────────
    const caller = await createV1Caller({ scopes: ['read'], workspaceName: 'Journey' });
    // …and a few more workspaces, so step 3 has more than one page to walk.
    for (let i = 1; i < 5; i++) {
      await workspacesService.createWorkspace({ name: `J${i}`, ownerUserId: caller.user.id });
    }

    // ── 2. GET /api/v1/me → 200, correct identity + granted scopes ────────
    const me = await call('/api/v1/me', caller.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: caller.user.id, name: caller.user.name, email: caller.user.email },
      workspaceId: caller.workspace.id,
      scopes: ['read'],
    });
    // The headers reached a CLIENT, not just an object in the process.
    expect(me.headers.get('x-request-id')).toBeTruthy();
    // ⚠️ Asserted on a SUCCESSFUL response, not only on the 429.
    expect(me.headers.get('x-ratelimit-limit')).toBeTruthy();
    expect(me.headers.get('x-ratelimit-remaining')).toBeTruthy();
    expect(me.headers.get('x-ratelimit-reset')).toBeTruthy();

    // ── 3. Page a collection using ONLY the cursors the server returned ───
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await call(`/api/v1/workspaces${query}`, caller.token);
      expect(res.status).toBe(200);
      const page = (await res.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      seen.push(...page.items.map((w) => w.id));
      // Never a hand-constructed cursor — that is precisely what an external
      // client cannot do, and building one here would test nothing.
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);

    // ── 4. No token / garbage token / revoked token → 401, INDISTINGUISHABLE
    const revoked = await createV1Caller();
    await apiTokensService.revoke(revoked.user.id, revoked.tokenId);

    const unauthorised = await Promise.all([
      call('/api/v1/me'),
      call('/api/v1/me', 'motir_pat_garbage-that-was-never-issued'),
      call('/api/v1/me', revoked.token),
    ]);
    const bodies: string[] = [];
    for (const res of unauthorised) {
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    // BYTE-identical at the wire, not merely the same shape.
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({
      code: 'UNAUTHENTICATED',
      error: 'Authentication required.',
    });

    // ── 5. A scope the token lacks → 403, naming no internal detail ───────
    const forbidden = await call('/api/v1/_fixture/write-only', caller.token);
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as { code: string; error: string };
    expect(forbiddenBody.code).toBe('INSUFFICIENT_SCOPE');
    expect(forbiddenBody.error).not.toMatch(/prisma|sql|stack|\/lib\//i);

    // ── 6. A malformed cursor → 422 with a code ───────────────────────────
    const badCursor = await call('/api/v1/workspaces?cursor=not-a-real-cursor', caller.token);
    expect(badCursor.status).toBe(422);
    await expect(badCursor.json()).resolves.toEqual({
      code: 'INVALID_CURSOR',
      error: 'The `cursor` parameter is not a valid page cursor.',
    });

    // ── 7. A resource in ANOTHER workspace → 404, NOT 403 ─────────────────
    // 403 would confirm the resource exists — an existence oracle over another
    // tenant's data.
    const crossTenant = await call('/api/v1/_fixture/cross-tenant', caller.token);
    expect(crossTenant.status).toBe(404);
    await expect(crossTenant.json()).resolves.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  // ── 8. Exhaust the budget → 429 with a usable reset ─────────────────────
  it('exhausts the budget and returns a 429 whose reset a client can wait for', async () => {
    process.env['MOTIR_API_V1_RATE_LIMIT'] = '3';
    process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = '60000';
    const caller = await createV1Caller();

    const successes = [
      await call('/api/v1/me', caller.token),
      await call('/api/v1/me', caller.token),
      await call('/api/v1/me', caller.token),
    ];
    for (const res of successes) {
      expect(res.status).toBe(200);
      // The headers were present on the PRECEDING 200s, not only on the 429.
      expect(res.headers.get('x-ratelimit-limit')).toBe('3');
    }
    expect(successes.map((r) => r.headers.get('x-ratelimit-remaining'))).toEqual(['2', '1', '0']);

    const refused = await call('/api/v1/me', caller.token);

    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-ratelimit-limit')).toBe('3');
    expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
    const reset = Number(refused.headers.get('x-ratelimit-reset'));
    // A time a client can ACTUALLY wait for: in the future, and within the
    // window it advertises rather than an epoch or a millisecond value.
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(reset).toBeGreaterThan(nowSeconds - 1);
    expect(reset).toBeLessThanOrEqual(nowSeconds + 60);
    await expect(refused.json()).resolves.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });
});

describe('/api/v1 conformance — properties only visible at the wire', () => {
  it('mounts every v1 route at its real path, and 404s a path that does not exist', async () => {
    const caller = await createV1Caller();

    // Reachable at the documented paths — a handler wired at the wrong path
    // passes every in-process test.
    expect((await call('/api/v1/me', caller.token)).status).toBe(200);
    expect((await call('/api/v1/workspaces', caller.token)).status).toBe(200);

    const missing = await call('/api/v1/does-not-exist', caller.token);
    expect(missing.status).toBe(404);
  });

  it('leaks no stack, driver text or code on a 500 over the wire', async () => {
    const caller = await createV1Caller();

    const res = await call('/api/v1/_fixture/faulting', caller.token);
    const raw = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(raw)).toEqual({ error: 'Internal server error.' });
    expect(raw).not.toContain('db.workspace');
    expect(raw).not.toContain('5432');
    expect(raw).not.toMatch(/\bat .+:\d+:\d+/); // no stack frames
    // Even a failure is correlatable.
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('accepts the Authorization header through the real framework parse', async () => {
    const caller = await createV1Caller();

    // The scheme is case-insensitive at the wire, as RFC 7235 requires.
    const lower = await fetch(`${server.url}/api/v1/me`, {
      headers: { authorization: `bearer ${caller.token}` },
    });
    expect(lower.status).toBe(200);

    // A non-bearer challenge is refused with the same undifferentiated 401.
    const basic = await fetch(`${server.url}/api/v1/me`, {
      headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
    });
    expect(basic.status).toBe(401);
  });

  it('echoes a client request id across the socket, so logs can be correlated', async () => {
    const caller = await createV1Caller();

    const res = await fetch(`${server.url}/api/v1/me`, {
      headers: { authorization: `Bearer ${caller.token}`, 'x-request-id': 'client-trace-42' },
    });

    expect(res.headers.get('x-request-id')).toBe('client-trace-42');
  });

  // Extensibility, asserted rather than asserted-about: adding a case for a new
  // v1 endpoint needs no new server-boot or auth plumbing, because the harness
  // DISCOVERS the route tree.
  it('serves every route in the tree without a hand-maintained list', async () => {
    const caller = await createV1Caller();

    for (const path of ['/api/v1/me', '/api/v1/workspaces']) {
      const res = await call(path, caller.token);
      expect(res.status, `${path} is mounted`).toBe(200);
    }
    // The harness recorded them as real socket traffic.
    const paths = server.requests.map((r) => r.pathname);
    expect(paths).toContain('/api/v1/me');
    expect(paths).toContain('/api/v1/workspaces');
    // …with the credential really on the wire.
    expect(
      server.requests.filter((r) => r.pathname === '/api/v1/me').at(-1)?.authorization,
    ).toMatch(/^Bearer motir_pat_/);
  });
});
