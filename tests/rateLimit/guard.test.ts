import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import {
  enforceRateLimit,
  isRateLimitExcluded,
  rateLimitedResponse,
  rateLimitResponseHeaders,
  stampRateLimitHeaders,
  RATE_LIMIT_EXCLUDED_PATHS,
  RATE_LIMITED_CODE,
} from '@/lib/rateLimit/guard';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import {
  ALIGNED_HEADROOM_MS,
  ALIGNED_WINDOW_MS,
  currentWindowStart,
  waitForWindowHeadroom,
} from '@/tests/helpers/rateLimitWindow';

// The route-edge guard: the 429's SHAPE, the headers, the exclusions, and the
// multi-limb contract (Subtask 8.5.9 / MOTIR-1165).
//
// ── THE WINDOW IS ALIGNED, AND USED TO NOT BE AT ALL (MOTIR-3016) ────────────
// This file declared `const WINDOW = 60_000` and handed it to every budget,
// with no alignment anywhere. `consumeSharedRateLimit` buckets on a grid aligned
// to the EPOCH, so a pair of calls meant to accumulate resets its counter
// whenever a minute boundary happens to fall between them, and the call expected
// to be refused is served instead — `expected null not to be null`, on a diff
// that touches no rate-limiting code. Unlucky PHASE, not a slow runner: it
// clears on a re-run every time and is invisible locally.
//
// It is the same defect MOTIR-2101 / -2224 / -2598 / -2647 / -2648 each fixed
// one file at a time, and it survived all five of them for a reason worth
// naming: MOTIR-2224's guard fails a file that RECOMPUTES the window phase, and
// this file recomputed nothing. It simply never aligned, and an absent call
// matches no pattern. Its own sibling `surfaceGuards.test.ts` — same directory —
// has aligned since MOTIR-2648. See `tests/helpers/rateLimitWindow.ts` for the
// arithmetic and the sizing, and `tests/api/v1/rate-limit-window-alignment.test.ts`
// for the guard, now widened to catch the absence rather than the copy.
//
// ── Which cases wait, and which do not ───────────────────────────────────────
// A case waits IFF it ACCUMULATES — it spends the budget more than once and
// asserts on the accumulated count (a refusal, or the counter read back). Two
// do:
//
//   'carries Retry-After AND the X-RateLimit triple'      2 calls → the 429
//   'spends EVERY limb, so tripping one does not leave …' 2 calls → the 429 + count
//
// The rest do not, and the reason is not "they are quick" — it is structural:
//
//   'reports the TIGHTEST limb in the success headers'  ONE counted call; a
//       straddle can only ever hand a case MORE budget, so it cannot turn an
//       assertion that something was ALLOWED red.
//   'pluralizes Retry-After copy…', 'merges caller-supplied headers…',
//   'an ALLOWED response carries…', 'stamps headers onto a handler response…'
//       build a `RateLimitDecision` by hand and never call the limiter — no
//       counter, no window, no clock.
//   every case under 'the never-limited paths'
//       pure path matching against `RATE_LIMIT_EXCLUDED_PATHS`.

beforeEach(async () => {
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  delete process.env[RATE_LIMIT_DISABLE_ENV];
});
afterEach(() => __resetSharedRateLimitStoreForTest());
afterAll(async () => {
  await db.$disconnect();
});

describe('the 429 is spec-correct', () => {
  it('carries Retry-After AND the X-RateLimit triple', async () => {
    const budget = { limit: 1, windowMs: ALIGNED_WINDOW_MS };
    const limb = {
      scope: 'public-write' as const,
      key: rateLimitKey('public-write', 'ip'),
      budget,
    };

    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    const first = await enforceRateLimit([limb]);
    expect(first.response).toBeNull();

    const second = await enforceRateLimit([limb]);
    const res = second.response;
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);

    const retryAfter = Number(res!.headers.get('Retry-After'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    // A window is at most `windowMs` away, and never zero — a `Retry-After: 0`
    // invites an immediate retry, which is the opposite of backing off.
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(ALIGNED_WINDOW_MS / 1000);

    expect(res!.headers.get('x-ratelimit-limit')).toBe('1');
    expect(res!.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(Number(res!.headers.get('x-ratelimit-reset'))).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );

    const body = (await res!.json()) as { code: string; error: string };
    expect(body.code).toBe(RATE_LIMITED_CODE);
    expect(body.error).toMatch(/Retry in \d+ seconds?\./);
  });

  it('pluralizes Retry-After copy correctly at one second', () => {
    const res = rateLimitedResponse({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 1,
      degraded: false,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1');
  });

  it('merges caller-supplied headers (e.g. CORS) without losing the limit headers', () => {
    const res = rateLimitedResponse(
      { allowed: false, limit: 1, remaining: 0, resetAt: 1, degraded: false },
      { 'access-control-allow-origin': 'https://motir.co' },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://motir.co');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('an ALLOWED response carries the budget headers but NO Retry-After', () => {
    const headers = rateLimitResponseHeaders({
      allowed: true,
      limit: 10,
      remaining: 7,
      resetAt: 123,
      degraded: false,
    });
    expect(headers['x-ratelimit-remaining']).toBe('7');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('stamps headers onto a handler response without replacing it', async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const stamped = stampRateLimitHeaders(original, { 'x-ratelimit-limit': '9' });
    expect(stamped.status).toBe(201);
    expect(stamped.headers.get('x-ratelimit-limit')).toBe('9');
    expect(await stamped.json()).toEqual({ ok: true });
  });
});

describe('several limbs', () => {
  it('spends EVERY limb, so tripping one does not leave the other cool', async () => {
    const ipKey = rateLimitKey('auth:sign-in', '203.0.113.1');
    const idKey = rateLimitKey('auth:sign-in', 'id', 'a@example.com');
    const limbs = [
      {
        scope: 'auth:sign-in' as const,
        key: ipKey,
        budget: { limit: 1, windowMs: ALIGNED_WINDOW_MS },
      },
      {
        scope: 'auth:sign-in' as const,
        key: idKey,
        budget: { limit: 5, windowMs: ALIGNED_WINDOW_MS },
      },
    ];

    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect((await enforceRateLimit(limbs)).response).toBeNull();
    // The IP limb is now spent, so this refuses — but the identifier limb must
    // ALSO have been counted, not short-circuited.
    expect((await enforceRateLimit(limbs)).response).not.toBeNull();

    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);
    expect(await rateLimitCounterRepository.findCountUnsafe(idKey, BigInt(windowStart))).toBe(2);
  });

  it('reports the TIGHTEST limb in the success headers', async () => {
    const limbs = [
      {
        scope: 'auth:sign-in' as const,
        key: rateLimitKey('auth:sign-in', 'wide'),
        budget: { limit: 100, windowMs: ALIGNED_WINDOW_MS },
      },
      {
        scope: 'auth:sign-in' as const,
        key: rateLimitKey('auth:sign-in', 'narrow'),
        budget: { limit: 3, windowMs: ALIGNED_WINDOW_MS },
      },
    ];
    const { response, headers } = await enforceRateLimit(limbs);
    expect(response).toBeNull();
    // 3 - 1 = 2 left on the narrow limb; 99 on the wide one.
    expect(headers['x-ratelimit-remaining']).toBe('2');
    expect(headers['x-ratelimit-limit']).toBe('3');
  });
});

describe('the never-limited paths', () => {
  it('excludes the Sentry tunnel and the health checks', () => {
    expect(isRateLimitExcluded('/monitoring')).toBe(true);
    expect(isRateLimitExcluded('/api/monitoring')).toBe(true);
    expect(isRateLimitExcluded('/api/health')).toBe(true);
    expect(isRateLimitExcluded('/api/healthz')).toBe(true);
  });

  it('matches nested paths under an excluded prefix', () => {
    expect(isRateLimitExcluded('/api/health/deep')).toBe(true);
    expect(isRateLimitExcluded('/monitoring/envelope')).toBe(true);
  });

  it('does NOT exclude a path that merely starts with the same characters', () => {
    // `/api/healthy-projects` is not the health check.
    expect(isRateLimitExcluded('/api/healthy-projects')).toBe(false);
    expect(isRateLimitExcluded('/monitoring-report')).toBe(false);
  });

  it('does not exclude the limited surfaces', () => {
    expect(isRateLimitExcluded('/api/auth/sign-in/email')).toBe(false);
    expect(isRateLimitExcluded('/api/ai/chat')).toBe(false);
    expect(isRateLimitExcluded('/api/public-requests/abc/upvote')).toBe(false);
  });

  it('the exclusion list names the tunnel route 8.5.6 has not shipped yet', () => {
    // Listed BEFORE the route exists so it is excluded the day it lands, rather
    // than the day someone notices error reports being dropped in a burst.
    expect(RATE_LIMIT_EXCLUDED_PATHS).toContain('/monitoring');
  });
});
