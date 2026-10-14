import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/me/route';
import { POST as TRANSITION } from '@/app/api/v1/work-items/[key]/transitions/route';
import { db } from '@/lib/db';
import { createInProcessRateLimitStore, resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import {
  __resetSharedRateLimitStoreForTest,
  __setSharedRateLimitStoreForTest,
} from '@/lib/rateLimit/store';
import { createV1Caller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { waitForWindowHeadroom } from '../../helpers/rateLimitWindow';

// `/api/v1` spends the per-WORKSPACE agent-volume ceiling beside its per-token
// limb (MOTIR-8601). Before it, N tokens in one workspace got N × the budget;
// minting tokens is self-service, so the ceiling is what a tenant cannot buy past.
//
// Both counters are fresh in-process stores: v1's per-token counter through
// `resetRateLimitStore`, and the shared store the ceiling counts in through
// `__setSharedRateLimitStoreForTest`. The window is a minute, and each case
// waits for headroom so its counted calls cannot straddle a boundary.

const WINDOW_MS = 60_000;
const HEADROOM_MS = 5_000;
const ENVS = [
  'MOTIR_API_V1_RATE_LIMIT',
  'MOTIR_API_V1_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT_WINDOW_MS',
] as const;

const ME = 'http://localhost:3000/api/v1/me';
const me = (headers: Record<string, string>) => GET(new Request(ME, { headers }));

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  __setSharedRateLimitStoreForTest(createInProcessRateLimitStore());
  delete process.env[RATE_LIMIT_DISABLE_ENV];
  process.env['MOTIR_API_V1_RATE_LIMIT'] = '100';
  process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = String(WINDOW_MS);
  process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '2';
  process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT_WINDOW_MS'] = String(WINDOW_MS);
  await waitForWindowHeadroom(WINDOW_MS, HEADROOM_MS);
});

afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  resetRateLimitStore();
  for (const name of ENVS) delete process.env[name];
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the /api/v1 workspace ceiling (MOTIR-8601)', () => {
  it('holds every token of a workspace under one ceiling, and leaves other workspaces alone', async () => {
    const first = await createV1Caller();
    const second = await withTokenFor(first.user, first.workspace);
    const elsewhere = await createV1Caller({ workspaceName: 'Elsewhere' });

    expect((await me(first.headers)).status).toBe(200);
    expect((await me(second.headers)).status).toBe(200);

    // Each token has 98 of its own left; the workspace has none.
    for (const caller of [first, second]) {
      const refused = await me(caller.headers);
      expect(refused.status).toBe(429);
      const body = (await refused.json()) as { code: string; retryAfterSeconds: number };
      expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.headers.get('Retry-After')).toBe(String(body.retryAfterSeconds));
      // The headers report the limb that refused: the ceiling.
      expect(refused.headers.get('x-ratelimit-limit')).toBe('2');
      expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
      expect(refused.headers.get('x-ratelimit-reset')).toBeTruthy();
    }

    expect((await me(elsewhere.headers)).status).toBe(200);
  });

  it('reports the TIGHTER limb on an allowed response', async () => {
    const caller = await createV1Caller();
    const res = await me(caller.headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('2');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('1');
  });

  it('spends neither limb on a 401', async () => {
    const caller = await createV1Caller();
    for (let i = 0; i < 3; i += 1) {
      const res = await me({});
      expect(res.status).toBe(401);
      expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    }
    // The workspace's whole ceiling is still there.
    expect((await me(caller.headers)).status).toBe(200);
    expect((await me(caller.headers)).status).toBe(200);
  });

  it('spends the per-token limb on a 403, and NOT the ceiling', async () => {
    // A `read` token lacks the transition permission; the auth result carries no
    // workspace, so only its own limb is spent.
    const reader = await createV1Caller({ scopes: ['read'] });
    for (let i = 0; i < 3; i += 1) {
      const res = await TRANSITION(
        new Request('http://localhost:3000/api/v1/work-items/MOTIR-1/transitions', {
          method: 'POST',
          headers: { ...reader.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'done' }),
        }),
        { params: Promise.resolve({ key: 'MOTIR-1' }) },
      );
      expect(res.status).toBe(403);
      // Metered on the token: its own 100-request budget counts down.
      expect(res.headers.get('x-ratelimit-limit')).toBe('100');
      expect(res.headers.get('x-ratelimit-remaining')).toBe(String(99 - i));
    }
    // Three refusals later, the workspace ceiling of 2 is untouched.
    const owner = await withTokenFor(reader.user, reader.workspace);
    expect((await me(owner.headers)).status).toBe(200);
    expect((await me(owner.headers)).status).toBe(200);
  });
});
