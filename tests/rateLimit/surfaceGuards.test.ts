import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import {
  classifyAuthRequest,
  authIdentifier,
  enforceAuthRateLimit,
} from '@/lib/rateLimit/authGuard';
import { enforcePublicWriteRateLimit } from '@/lib/rateLimit/publicWriteGuard';
import { enforceAiRateLimit, enforceInternalServiceRateLimit } from '@/lib/rateLimit/aiGuard';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { JobAuthError, JobRateLimitedError } from '@/lib/ai/jobAuth';
import { rateLimitedResponse } from '@/lib/rateLimit/guard';

// The three SURFACE guards (Subtask 8.5.9 / MOTIR-1165): which requests each one
// limits, what it keys on, and the axis it must NOT key on.
//
// Budgets come from the environment, so each case pins the ones it needs to a
// tiny number — that is the same mechanism a deployment uses, exercised.

const ENVS = [
  'MOTIR_AUTH_RATE_LIMIT',
  'MOTIR_AUTH_RATE_LIMIT_WINDOW_MS',
  'MOTIR_PASSWORD_RESET_RATE_LIMIT',
  'MOTIR_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS',
  'MOTIR_PUBLIC_WRITE_RATE_LIMIT',
  'MOTIR_PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_RATE_LIMIT',
  'MOTIR_AI_RATE_LIMIT_WINDOW_MS',
  RATE_LIMIT_DISABLE_ENV,
];

beforeEach(async () => {
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  for (const key of ENVS) delete process.env[key];
});
afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  for (const key of ENVS) delete process.env[key];
});
afterAll(async () => {
  await db.$disconnect();
});

function authReq(path: string, body?: unknown, ip = '203.0.113.10'): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

describe('the auth surface', () => {
  it('classifies the credential-bearing paths and NOTHING else', () => {
    expect(classifyAuthRequest('/api/auth/sign-in/email')).toBe('auth:sign-in');
    expect(classifyAuthRequest('/api/auth/sign-up/email')).toBe('auth:sign-up');
    expect(classifyAuthRequest('/api/auth/request-password-reset')).toBe('auth:password-reset');
    expect(classifyAuthRequest('/api/auth/forget-password')).toBe('auth:password-reset');
    expect(classifyAuthRequest('/api/auth/reset-password')).toBe('auth:password-reset');
  });

  it('leaves sign-out, session reads, OAuth callbacks and the device poll ALONE', () => {
    // The device grant polls every 5s BY DESIGN and has its own `slow_down`
    // throttle — a limiter there would break the normal flow, not an attack.
    for (const path of [
      '/api/auth/sign-out',
      '/api/auth/get-session',
      '/api/auth/callback/google',
      '/api/auth/device/token',
      '/api/auth/device/code',
    ]) {
      expect(classifyAuthRequest(path)).toBeNull();
    }
  });

  it('an unlimited path is never refused, however many times it is called', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    for (let i = 0; i < 5; i += 1) {
      expect(await enforceAuthRateLimit(authReq('/api/auth/sign-out'))).toBeNull();
    }
  });

  it('refuses the (N+1)-th sign-in from one IP with a 429 + Retry-After', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '3';
    for (let i = 0; i < 3; i += 1) {
      expect(
        await enforceAuthRateLimit(authReq('/api/auth/sign-in/email', { email: `u${i}@x.com` })),
      ).toBeNull();
    }
    const refused = await enforceAuthRateLimit(
      authReq('/api/auth/sign-in/email', { email: 'u4@x.com' }),
    );
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(429);
    expect(Number(refused!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('keys per IDENTIFIER too, so one account cannot be attacked from many IPs', async () => {
    // The per-IP limb is generous; the identifier limb is what bites.
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '2';
    const victim = { email: 'victim@example.com' };
    // Two attempts from two DIFFERENT IPs — each IP limb is at 1 of 2, but the
    // identifier limb is now at 2 of 2.
    expect(
      await enforceAuthRateLimit(authReq('/api/auth/sign-in/email', victim, '1.1.1.1')),
    ).toBeNull();
    expect(
      await enforceAuthRateLimit(authReq('/api/auth/sign-in/email', victim, '2.2.2.2')),
    ).toBeNull();
    const refused = await enforceAuthRateLimit(
      authReq('/api/auth/sign-in/email', victim, '3.3.3.3'),
    );
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(429);
  });

  it('sign-in and sign-up are SEPARATE buckets', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    expect(await enforceAuthRateLimit(authReq('/api/auth/sign-in/email'))).toBeNull();
    // Same IP, different scope — untouched budget.
    expect(await enforceAuthRateLimit(authReq('/api/auth/sign-up/email'))).toBeNull();
    expect(await enforceAuthRateLimit(authReq('/api/auth/sign-in/email'))).not.toBeNull();
  });

  it('password reset takes the TIGHTER budget, not the sign-in one', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '100';
    process.env['MOTIR_PASSWORD_RESET_RATE_LIMIT'] = '1';
    expect(await enforceAuthRateLimit(authReq('/api/auth/request-password-reset'))).toBeNull();
    const refused = await enforceAuthRateLimit(authReq('/api/auth/request-password-reset'));
    expect(refused).not.toBeNull();
    expect(refused!.headers.get('x-ratelimit-limit')).toBe('1');
  });

  it('reads the identifier from a CLONE, leaving the body readable for Better-Auth', async () => {
    // If the guard consumed the stream, every limited endpoint would 500 — the one
    // way this guard could break the surface it protects.
    const req = authReq('/api/auth/sign-in/email', { email: 'Reader@Example.com  ' });
    expect(await authIdentifier(req)).toBe('reader@example.com');
    await expect(req.json()).resolves.toEqual({ email: 'Reader@Example.com  ' });
  });

  it('survives a body that is absent, not JSON, or carries no email', async () => {
    expect(await authIdentifier(authReq('/api/auth/sign-in/email'))).toBeNull();
    expect(await authIdentifier(authReq('/api/auth/sign-in/email', { email: 42 }))).toBeNull();
    expect(await authIdentifier(authReq('/api/auth/sign-in/email', { email: '  ' }))).toBeNull();
    const notJson = new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      body: 'not json at all',
    });
    expect(await authIdentifier(notJson)).toBeNull();
  });

  it('an unparseable body still gets the per-IP limb (no free pass)', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    const make = () =>
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        body: 'not json',
      });
    expect(await enforceAuthRateLimit(make())).toBeNull();
    expect(await enforceAuthRateLimit(make())).not.toBeNull();
  });

  it('never limits an excluded path, even one shaped like a limited one', async () => {
    process.env['MOTIR_AUTH_RATE_LIMIT'] = '1';
    const health = new Request('http://localhost/api/health/sign-in/email', { method: 'POST' });
    for (let i = 0; i < 4; i += 1) expect(await enforceAuthRateLimit(health)).toBeNull();
  });
});

// ── PUBLIC WRITE ─────────────────────────────────────────────────────────────

describe('the public-write surface', () => {
  it('refuses the (N+1)-th write from one IP', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '2';
    const req = () =>
      new Request('http://localhost/api/public-requests/abc/upvote', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.4' },
      });
    expect(await enforcePublicWriteRateLimit(req())).toBeNull();
    expect(await enforcePublicWriteRateLimit(req())).toBeNull();
    const refused = await enforcePublicWriteRateLimit(req());
    expect(refused!.status).toBe(429);
    await expect(refused!.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('is keyed on IP — a different origin has its own budget', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    const at = (ip: string) =>
      new Request('http://localhost/api/public/projects/p1/requests', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
      });
    expect(await enforcePublicWriteRateLimit(at('1.2.3.4'))).toBeNull();
    expect(await enforcePublicWriteRateLimit(at('5.6.7.8'))).toBeNull();
    expect(await enforcePublicWriteRateLimit(at('1.2.3.4'))).not.toBeNull();
  });

  it('shares ONE bucket across the public-write endpoints (a scope, not a route)', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    const ip = { 'x-forwarded-for': '203.0.113.55' };
    expect(
      await enforcePublicWriteRateLimit(
        new Request('http://localhost/api/public/projects/p1/requests', {
          method: 'POST',
          headers: ip,
        }),
      ),
    ).toBeNull();
    // A different endpoint, same abuse budget — an attacker must not get a fresh
    // allowance per URL.
    expect(
      await enforcePublicWriteRateLimit(
        new Request('http://localhost/api/public-requests/r1/comments', {
          method: 'POST',
          headers: ip,
        }),
      ),
    ).not.toBeNull();
  });

  it('never limits an excluded path', async () => {
    process.env['MOTIR_PUBLIC_WRITE_RATE_LIMIT'] = '1';
    const health = new Request('http://localhost/api/health', { method: 'POST' });
    for (let i = 0; i < 4; i += 1) {
      expect(await enforcePublicWriteRateLimit(health)).toBeNull();
    }
  });
});

// ── AI ───────────────────────────────────────────────────────────────────────

describe('the AI surface', () => {
  const ctx = { userId: 'user_1', workspaceId: 'ws_1' };

  it('refuses the (N+1)-th call for one user+workspace', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '2';
    expect(await enforceAiRateLimit(ctx)).toBeNull();
    expect(await enforceAiRateLimit(ctx)).toBeNull();
    const refused = await enforceAiRateLimit(ctx);
    expect(refused!.status).toBe(429);
  });

  it('keys on USER + WORKSPACE, never on IP', async () => {
    // The AC's axis check. The guard is not even given the request, so an IP
    // cannot leak into the key — and two users behind one NAT keep separate
    // budgets while one user keeps ONE budget across networks.
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w1' })).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u2', workspaceId: 'w1' })).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w2' })).toBeNull();
    expect(await enforceAiRateLimit({ userId: 'u1', workspaceId: 'w1' })).not.toBeNull();
  });

  it('the browser and service-to-service surfaces are SEPARATE budgets', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    expect(await enforceAiRateLimit(ctx, 'ai:chat')).toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:internal')).toBeNull();
    expect(await enforceAiRateLimit(ctx, 'ai:chat')).not.toBeNull();
  });
});

describe('the tenant-LESS internal routes (service-bearer gated)', () => {
  // `live-projects` and `work-items` carry no tenant at all, so they key on the
  // CREDENTIAL — the axis /api/v1 uses for the same reason.
  const withBearer = (secret: string) =>
    new Request('http://localhost/api/internal/ai/live-projects', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'x-forwarded-for': '10.0.0.1' },
    });

  it('refuses the (N+1)-th call for one credential', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '2';
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    const refused = await enforceInternalServiceRateLimit(withBearer('secret-a'));
    expect(refused!.status).toBe(429);
    expect(Number(refused!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('keys on the CREDENTIAL, not the IP — a second secret has its own budget', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    // Same IP on both calls; only the bearer differs.
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    expect(await enforceInternalServiceRateLimit(withBearer('secret-b'))).toBeNull();
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).not.toBeNull();
  });

  it('a request with NO bearer still counts, rather than reading as unlimited', async () => {
    // Unreachable from a route (the bearer check runs first and fails closed), but
    // keyed rather than skipped so a future reordering cannot open a hole.
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    const bare = () =>
      new Request('http://localhost/api/internal/ai/live-projects', { method: 'POST' });
    expect(await enforceInternalServiceRateLimit(bare())).toBeNull();
    expect(await enforceInternalServiceRateLimit(bare())).not.toBeNull();
  });

  it('does not share a bucket with the job-token internal calls', async () => {
    process.env['MOTIR_AI_RATE_LIMIT'] = '1';
    expect(await enforceInternalServiceRateLimit(withBearer('secret-a'))).toBeNull();
    // A job-token caller in the same scope keys on workspace+user, so its bucket
    // is untouched by the credential one.
    expect(await enforceAiRateLimit({ userId: 'u', workspaceId: 'w' }, 'ai:internal')).toBeNull();
  });
});

describe('the internal-AI error mapper', () => {
  it('passes the limiter response through UNTOUCHED, headers included', async () => {
    const built = rateLimitedResponse({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 30,
      degraded: false,
    });
    const mapped = mapJobRequestError(new JobRateLimitedError(built));
    expect(mapped).toBe(built);
    expect(mapped!.status).toBe(429);
    expect(mapped!.headers.get('Retry-After')).toBeTruthy();
    expect(mapped!.headers.get('x-ratelimit-limit')).toBe('3');
  });

  it('still maps the 401 auth failure it replaced', async () => {
    const mapped = mapJobRequestError(new JobAuthError('token_invalid', 'nope'));
    expect(mapped!.status).toBe(401);
    await expect(mapped!.json()).resolves.toEqual({ code: 'token_invalid', error: 'nope' });
  });

  it('returns null for anything else, so the route rethrows a genuine 500', () => {
    expect(mapJobRequestError(new Error('boom'))).toBeNull();
    expect(mapJobRequestError('not an error')).toBeNull();
  });
});

// ── WIRING ───────────────────────────────────────────────────────────────────

describe('the routes are actually WIRED to the guards', () => {
  // A guard nobody calls protects nothing, and every case above tests the guard
  // rather than the route. These read the route sources so a future edit that
  // drops an enforcement call fails here instead of silently un-limiting a
  // surface.
  const wiring: ReadonlyArray<[string, string]> = [
    ['app/api/auth/[...all]/route.ts', 'enforceAuthRateLimit'],
    ['app/api/public/projects/[projectId]/requests/route.ts', 'enforcePublicWriteRateLimit'],
    ['app/api/public-requests/[id]/comments/route.ts', 'enforcePublicWriteRateLimit'],
    ['app/api/public-requests/[id]/upvote/route.ts', 'enforcePublicWriteRateLimit'],
    ['app/api/ai/chat/route.ts', 'enforceAiRateLimit'],
  ];

  it.each(wiring)('%s calls %s', (file, symbol) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(symbol);
  });

  it('EVERY authenticated /api/internal/ai route is limited, by one of the two gates', async () => {
    // The class has TWO auth families and both had to be covered — the job-token
    // gate (a tenant is in the request, so the key is workspace + user) and the
    // service-bearer gate (`live-projects`, `work-items`: no tenant at all, so the
    // key is the credential). Enumerating from the filesystem rather than a hand
    // list is the point: a NEW internal-AI route shipped without a limit fails
    // here, which is the only way this stays true after today.
    const { globSync } = await import('node:fs');
    const routes = globSync('app/api/internal/ai/**/route.ts');
    expect(routes.length).toBeGreaterThan(14);

    const unlimited: string[] = [];
    for (const file of routes) {
      const source = readFileSync(file, 'utf8');
      const jobGated = /\bauthenticate(AndLimit)?JobRequest\b/.test(source);
      const serviceGated = /\bauthenticateServiceRequest\(/.test(source);

      if (jobGated) {
        expect(source, `${file} must use the LIMITED job gate`).toContain(
          'authenticateAndLimitJobRequest',
        );
        // The unlimited gate must no longer be CALLED from any route (the
        // remaining mentions are prose in the header comments).
        expect(source, `${file} must not call the unlimited job gate`).not.toMatch(
          /[^dt]\bauthenticateJobRequest\(/,
        );
      } else if (serviceGated) {
        expect(source, `${file} must use the service-credential limiter`).toContain(
          'enforceInternalServiceRateLimit',
        );
      } else {
        unlimited.push(file);
      }
    }

    // Exactly one route carries no auth and therefore no limit: the dev-only
    // no-op seam. Named explicitly so a second unauthenticated route cannot slip
    // in behind a passing test.
    expect(unlimited).toEqual(['app/api/internal/ai/dev/noop/route.ts']);
  });
});
