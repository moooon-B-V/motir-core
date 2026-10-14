import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { createV1Caller } from '../fixtures/apiV1Fixtures';
import { waitForWindowHeadroom } from '../helpers/rateLimitWindow';
import { TWO_INSTANCE_BUDGETS } from './globalSetup';
import { clientFor, type InstanceName } from './harness';

// THE LIMIT CASES (Story MOTIR-8547 · MOTIR-8617) — every limit is counted ONCE
// across the fleet, proven over two real production-build processes.
//
// Each case spends a budget partly on A and partly on B and asserts the refusal
// lands where a single fleet-wide counter puts it. A per-process counter (a
// module-scope `Map`, or Better-Auth's default `memory` storage) would let the
// call that crosses machines through — and only two processes can show that,
// which is why this sits in the two-instance lane and not beside the in-process
// tests.
//
// Every case also runs a CONTROL — the same sequence sent entirely to ONE
// process, on a fresh identity — and asserts the refusal lands on the same
// call. A pass that only holds because the budget is tiny cannot hide there.
//
// Every assertion is on an HTTP status, header or body from a real process; no
// limiter object is consulted in-process.
//
// ⚠️ The file name: the card names `limits.test.ts`, and this is
// `limits.spec.ts`, because the default lane's `tests/**/*.test.{ts,tsx}` would
// otherwise pick it up and run it with no servers (`vitest.two-instance.config.ts`).

const app = clientFor(inject('twoInstanceApp'));

/** Better-Auth trusts this origin in every build (`trustedOrigins`). */
const ORIGIN = 'http://localhost:3000';

/**
 * A fresh client IP per sequence, so no case (or control) spends another's
 * bucket. It goes in `x-forwarded-for` as a SINGLE value: Better-Auth 1.7.7
 * reads that header by default (`@better-auth/core` `utils/ip.mjs`,
 * `DEFAULT_IP_HEADERS = ['x-forwarded-for']`) and, with no `trustedProxies`
 * configured, trusts it only when it carries exactly one address. The app-level
 * guard reads the same header's first hop (`lib/rateLimit/keys.ts`), so both
 * limiters key this caller on the same IP.
 */
function freshIp(): string {
  const [a = 0, b = 0] = randomBytes(2);
  return `198.19.${a}.${b}`;
}

function freshEmail(): string {
  return `two-instance-limit-${randomUUID()}@example.com`;
}

/**
 * Better-Auth's own refusal, told apart from the app-level guard's
 * (`lib/rateLimit/authGuard.ts` → `rateLimitedResponse`). Better-Auth answers
 * `{ message }` with an `X-Retry-After` header and no `X-RateLimit-*`; the app
 * guard answers `{ code: 'RATE_LIMITED', error }` with `Retry-After` and
 * `X-RateLimit-*`. The app guard's budgets (20 / min sign-in, 5 / hour reset)
 * are wider than Better-Auth's 3, so the tighter bucket must be the one that
 * trips — and this proves it was.
 */
async function expectBetterAuthRefusal(res: Response, windowSeconds: number): Promise<void> {
  expect(res.status).toBe(429);
  const retryAfter = Number(res.headers.get('x-retry-after'));
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
  expect(res.headers.get('x-ratelimit-limit')).toBeNull();
  const body = (await res.json()) as { message?: string; code?: string };
  expect(body.code).toBeUndefined();
  expect(body.message).toMatch(/too many requests/i);
}

/** The status of each call in a sequence, sent to the named machines in order. */
async function statuses(
  machines: readonly InstanceName[],
  send: (machine: InstanceName) => Promise<Response>,
): Promise<{ statuses: number[]; last: Response }> {
  const out: number[] = [];
  let last: Response | undefined;
  for (const machine of machines) {
    last = await send(machine);
    out.push(last.status);
    // Drain every body but the last, which the caller reads.
    if (out.length < machines.length) await last.arrayBuffer();
  }
  if (!last) throw new Error('empty sequence');
  return { statuses: out, last };
}

describe('Better-Auth /request-password-reset — 3 per hour, counted across A and B', () => {
  const WINDOW_S = 3600;

  function requestReset(ip: string, email: string) {
    return (machine: InstanceName) =>
      app.sendTo(machine, '/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip },
        body: JSON.stringify({ email, redirectTo: '/reset-password' }),
      });
  }

  it('A, A, A then B: the 4th is refused by Better-Auth, and one process alone refuses the same call', async () => {
    // The hour-long cell rarely needs it, but a case that starts in its last
    // 10 s would watch the reset land mid-sequence.
    await waitForWindowHeadroom(WINDOW_S * 1000, 10_000);

    const split = await statuses(['A', 'A', 'A', 'B'], requestReset(freshIp(), freshEmail()));
    expect(split.statuses.slice(0, 3)).not.toContain(429);
    await expectBetterAuthRefusal(split.last, WINDOW_S);

    const control = await statuses(['A', 'A', 'A', 'A'], requestReset(freshIp(), freshEmail()));
    expect(control.statuses.slice(0, 3)).not.toContain(429);
    await expectBetterAuthRefusal(control.last, WINDOW_S);
  });
});

describe('Better-Auth /sign-in — 3 per 10 s, counted across A and B', () => {
  const WINDOW_S = 10;

  function signIn(ip: string, email: string) {
    // Wrong credentials are the point: the limiter counts the request, not the
    // outcome, so calls 1-3 are 401 and the 4th is the refusal.
    return (machine: InstanceName) =>
      app.sendTo(machine, '/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': ip },
        body: JSON.stringify({ email, password: 'not-the-password-1' }),
      });
  }

  it('A, A, B then A: the 4th is refused by Better-Auth', async () => {
    await waitForWindowHeadroom(WINDOW_S * 1000, 4_000);
    const split = await statuses(['A', 'A', 'B', 'A'], signIn(freshIp(), freshEmail()));
    expect(split.statuses.slice(0, 3)).toEqual([401, 401, 401]);
    await expectBetterAuthRefusal(split.last, WINDOW_S);
  });

  it('control: four calls to A refuse the same 4th call', async () => {
    await waitForWindowHeadroom(WINDOW_S * 1000, 4_000);
    const control = await statuses(['A', 'A', 'A', 'A'], signIn(freshIp(), freshEmail()));
    expect(control.statuses.slice(0, 3)).toEqual([401, 401, 401]);
    await expectBetterAuthRefusal(control.last, WINDOW_S);
  });
});

/** Every response in a budgeted sequence carries the limiter's headers. */
function expectRateLimitHeaders(res: Response, limit: number): void {
  expect(res.headers.get('x-ratelimit-limit')).toBe(String(limit));
  expect(res.headers.get('x-ratelimit-remaining')).toMatch(/^\d+$/);
  expect(res.headers.get('x-ratelimit-reset')).toMatch(/^\d+$/);
}

describe('MCP transport volume budget — B = 6 per 60 s, B−1 on A then 2 on B', () => {
  const { limit, windowMs } = TWO_INSTANCE_BUDGETS.mcp;

  function toolsList(token: string) {
    return (machine: InstanceName) =>
      app.sendTo(machine, '/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
  }

  async function run(machines: readonly InstanceName[]): Promise<void> {
    // The MCP bucket is keyed on (workspaceId, userId): a fresh owner and
    // workspace per sequence.
    const { token } = await createV1Caller({ label: 'two-instance MCP' });
    await waitForWindowHeadroom(windowMs, 10_000);
    const send = toolsList(token);
    for (const [i, machine] of machines.entries()) {
      const res = await send(machine);
      const n = i + 1;
      expectRateLimitHeaders(res, limit);
      if (n < limit) {
        expect(res.status, `call ${n} on ${machine}`).toBe(200);
        await res.arrayBuffer();
      } else if (n === limit) {
        // The call that spends the last unit is served, and says so.
        expect(res.status, `call ${n} on ${machine}`).toBe(200);
        expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
        await res.arrayBuffer();
      } else {
        expect(res.status, `call ${n} on ${machine}`).toBe(429);
        expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
        const body = (await res.json()) as {
          jsonrpc: string;
          id: unknown;
          error: { code: number; data: { code: string; retryAfterSeconds: number; limit: number } };
        };
        expect(body.jsonrpc).toBe('2.0');
        expect(body.id).toBeNull();
        expect(body.error.code).toBe(-32029);
        expect(body.error.data.code).toBe('RATE_LIMITED');
        expect(body.error.data.limit).toBe(limit);
        expect(body.error.data.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    }
  }

  it('5 to A, then 2 to B: the 6th (first on B) is served with remaining 0, the 7th is 429', async () => {
    await run(['A', 'A', 'A', 'A', 'A', 'B', 'B']);
  });

  it('control: 7 to A refuse the same 7th call', async () => {
    await run(['A', 'A', 'A', 'A', 'A', 'A', 'A']);
  });
});

describe('/api/v1 per-token budget — 5 per 60 s, 4 on A then 2 on B', () => {
  const { limit, windowMs } = TWO_INSTANCE_BUDGETS.apiV1;

  // `GET /api/v1/me` — the cheapest authed v1 read: no collection, 200 for any
  // fresh token. It is a `withV1Route` handler, so it runs through the shared
  // wrapper's `consumeRateLimit` by construction (`lib/api/v1/route.ts`), keyed
  // on the token fingerprint.
  function me(token: string) {
    return (machine: InstanceName) =>
      app.sendTo(machine, '/api/v1/me', { headers: { authorization: `Bearer ${token}` } });
  }

  async function run(machines: readonly InstanceName[]): Promise<void> {
    const { token } = await createV1Caller({ label: 'two-instance v1' });
    await waitForWindowHeadroom(windowMs, 10_000);
    const send = me(token);
    for (const [i, machine] of machines.entries()) {
      const res = await send(machine);
      const n = i + 1;
      expectRateLimitHeaders(res, limit);
      if (n <= limit) {
        expect(res.status, `call ${n} on ${machine}`).toBe(200);
        if (n === limit) expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
        await res.arrayBuffer();
      } else {
        expect(res.status, `call ${n} on ${machine}`).toBe(429);
        const body = (await res.json()) as { code?: string };
        expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
      }
    }
  }

  it('4 to A, then 2 to B: the 5th (first on B) is served with remaining 0, the 6th is 429', async () => {
    await run(['A', 'A', 'A', 'A', 'B', 'B']);
  });

  it('control: 6 to A refuse the same 6th call', async () => {
    await run(['A', 'A', 'A', 'A', 'A', 'A']);
  });
});
