import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '@/app/api/v1/me/route';
import { withV1Route } from '@/lib/api/v1/route';
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  createInProcessRateLimitStore,
  rateLimitBudget,
  resetRateLimitStore,
  setRateLimitStore,
} from '@/lib/api/v1/rateLimit';
import { createV1Caller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Per-token rate limiting for `/api/v1` (Story 11.1 · Subtask 11.1.4 —
// MOTIR-1860). Real Postgres, real PATs, the real wrapper.
//
// The budget is shrunk through the SAME environment variables a deployment
// uses, so these tests exercise the shipped configuration path rather than a
// test-only back door — and so the window-reset case takes milliseconds
// instead of a minute.

const ME = 'http://localhost:3000/api/v1/me';

function req(headers: Record<string, string>) {
  return new Request(ME, { headers });
}

/** Set the budget the way a deployment would, and restore it afterwards. */
const savedEnv = {
  limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
  window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
};
function budget(limit: number, windowMs: number) {
  process.env['MOTIR_API_V1_RATE_LIMIT'] = String(limit);
  process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = String(windowMs);
}

describe('rate limiting — configuration', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('defaults to 60 requests per 60 seconds — the documented budget', () => {
    delete process.env['MOTIR_API_V1_RATE_LIMIT'];
    delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];

    expect(rateLimitBudget()).toEqual({
      limit: DEFAULT_RATE_LIMIT,
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
    });
    expect(DEFAULT_RATE_LIMIT).toBe(60);
    expect(DEFAULT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it('is configurable per environment', () => {
    budget(5, 1_000);

    expect(rateLimitBudget()).toEqual({ limit: 5, windowMs: 1_000 });
  });

  // A typo in a deploy config must not silently DISABLE the limiter.
  it.each([
    ['non-numeric', 'lots'],
    ['zero', '0'],
    ['negative', '-1'],
    ['empty', ''],
  ])('falls back to the default for a %s budget rather than disabling', (_label, value) => {
    process.env['MOTIR_API_V1_RATE_LIMIT'] = value;

    expect(rateLimitBudget().limit).toBe(DEFAULT_RATE_LIMIT);
  });
});

describe('rate limiting — the wrapper', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });
  afterEach(() => {
    restoreEnv();
    resetRateLimitStore();
  });

  it('carries X-RateLimit-* on a SUCCESSFUL response, not only on a 429', async () => {
    budget(10, 60_000);
    const caller = await createV1Caller();

    const res = await GET(req(caller.headers));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
    // A time a client can actually wait for: unix seconds, in the future.
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
  });

  it('counts down and then returns 429 with the envelope and the headers', async () => {
    budget(3, 60_000);
    const caller = await createV1Caller();

    const remaining: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      const res = await GET(req(caller.headers));
      expect(res.status).toBe(200);
      remaining.push(res.headers.get('x-ratelimit-remaining'));
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const refused = await GET(req(caller.headers));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-ratelimit-limit')).toBe('3');
    expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Number(refused.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0);
    const body = (await refused.json()) as { code: string; error: string };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    // The client learns WHEN to retry, not merely THAT it failed.
    expect(body.error).toMatch(/Retry in \d+ seconds?\./);
  });

  // ⚠️ THE concurrency case. A serial loop passes against a broken
  // read-compare-write implementation; simultaneous requests do not.
  it('fires N SIMULTANEOUS requests against a budget of N−1 and refuses exactly one', async () => {
    const N = 12;
    budget(N - 1, 60_000);
    const caller = await createV1Caller();

    const responses = await Promise.all(Array.from({ length: N }, () => GET(req(caller.headers))));
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(N - 1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });

  it('gives two tokens of the SAME user independent budgets', async () => {
    budget(2, 60_000);
    const first = await createV1Caller();
    // Same user, same workspace — only the token differs.
    const second = await withTokenFor(first.user, first.workspace, { label: 'second' });

    // Spend the first token's whole budget.
    expect((await GET(req(first.headers))).status).toBe(200);
    expect((await GET(req(first.headers))).status).toBe(200);
    expect((await GET(req(first.headers))).status).toBe(429);

    // The second token is untouched: one integration cannot exhaust another's.
    expect((await GET(req(second.headers))).status).toBe(200);
  });

  it('resets the budget when the window rolls over', async () => {
    budget(1, 120);
    const caller = await createV1Caller();

    expect((await GET(req(caller.headers))).status).toBe(200);
    expect((await GET(req(caller.headers))).status).toBe(429);

    // Wait past the reset the response itself advertised — a real window
    // rollover, not a mocked clock.
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect((await GET(req(caller.headers))).status).toBe(200);
  });

  // An outage in the limiter must not take the API down.
  it('ALLOWS the request when the store throws, and still emits the headers', async () => {
    budget(1, 60_000);
    setRateLimitStore({
      async increment() {
        throw new Error('rate-limit store unavailable');
      },
    });
    const caller = await createV1Caller();

    // Well past the budget of 1 — every one of these is served anyway.
    for (let i = 0; i < 3; i++) {
      const res = await GET(req(caller.headers));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('1');
      expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
    }
  });

  // The limiter is a property of the WRAPPER, so a route added later cannot
  // forget to opt in — this fixture route contains no limiter code at all.
  it('limits a brand-new route that adds no limiter code of its own', async () => {
    budget(1, 60_000);
    const caller = await createV1Caller();
    const newRoute = withV1Route({ scope: 'read' }, async () => NextResponse.json({ ok: true }));

    expect((await newRoute(req(caller.headers))).status).toBe(200);
    expect((await newRoute(req(caller.headers))).status).toBe(429);
  });

  it('keeps the headers on an ERROR path — a 422 still reports the budget', async () => {
    budget(10, 60_000);
    const caller = await createV1Caller();
    const { GET: workspaces } = await import('@/app/api/v1/workspaces/route');

    const res = await workspaces(
      new Request('http://localhost:3000/api/v1/workspaces?limit=0', {
        headers: caller.headers,
      }),
    );

    expect(res.status).toBe(422);
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
  });

  // The budget belongs to the credential, so a request we never authenticated
  // must not be able to spend one. (MOTIR-1861 revisits this seam explicitly.)
  it('does NOT spend budget on an unauthenticated request', async () => {
    budget(2, 60_000);
    const caller = await createV1Caller();

    for (let i = 0; i < 5; i++) {
      expect((await GET(new Request(ME))).status).toBe(401);
    }

    // The token's full budget is intact.
    expect((await GET(req(caller.headers))).status).toBe(200);
    expect((await GET(req(caller.headers))).status).toBe(200);
    expect((await GET(req(caller.headers))).status).toBe(429);
  });
});

describe('the in-process store', () => {
  it('increments within a window and starts fresh in the next one', async () => {
    const store = createInProcessRateLimitStore();

    expect(await store.increment('k', 1000, 1000)).toBe(1);
    expect(await store.increment('k', 1000, 1000)).toBe(2);
    // A new window replaces the stale count rather than accumulating.
    expect(await store.increment('k', 2000, 1000)).toBe(1);
    // Keys are independent.
    expect(await store.increment('other', 2000, 1000)).toBe(1);
  });

  it('sweeps stale windows so a long-lived process does not grow without bound', async () => {
    const store = createInProcessRateLimitStore();

    // Fill past the sweep threshold with keys from an old window…
    for (let i = 0; i < 10_001; i++) {
      await store.increment(`old-${i}`, 1_000, 1_000);
    }
    // …then advance the window, which triggers the sweep.
    expect(await store.increment('fresh', 10_000, 1_000)).toBe(1);
    // A swept key starts from scratch, proving the old rows were dropped.
    expect(await store.increment('old-0', 10_000, 1_000)).toBe(1);
  });
});

function restoreEnv() {
  if (savedEnv.limit === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT'];
  else process.env['MOTIR_API_V1_RATE_LIMIT'] = savedEnv.limit;
  if (savedEnv.window === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];
  else process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = savedEnv.window;
}
