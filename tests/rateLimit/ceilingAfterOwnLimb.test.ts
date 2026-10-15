import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as ME } from '@/app/api/v1/me/route';
import { db } from '@/lib/db';
import { authenticateAndLimitJobRequest, JobRateLimitedError } from '@/lib/ai/jobAuth';
import { mintJobToken } from '@/lib/ai/jobToken';
import { createInProcessRateLimitStore, resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import type { RateLimitStore } from '@/lib/api/v1/rateLimit';
import { agentWorkspaceBudget } from '@/lib/rateLimit/budgets';
import {
  enforceRateLimitOwnThenShared,
  spendOwnThenShared,
  type RateLimitLimb,
} from '@/lib/rateLimit/guard';
import { consumeSharedRateLimit, RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { enforceMcpRateLimit } from '@/lib/rateLimit/mcpGuard';
import {
  __resetSharedRateLimitStoreForTest,
  __setSharedRateLimitStoreForTest,
} from '@/lib/rateLimit/store';
import { agentWorkspaceLimb } from '@/lib/rateLimit/workspaceCeiling';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import { createV1Caller, withTokenFor } from '@/tests/fixtures/apiV1Fixtures';
import { truncateAuthTables, truncateRateLimitCounters } from '@/tests/helpers/db';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { currentWindowStart, waitForWindowHeadroom } from '@/tests/helpers/rateLimitWindow';

// The workspace ceiling is spent only AFTER the caller's own limb admits
// (MOTIR-8610, Story MOTIR-8548).
//
// Before this, MCP, `/api/v1` and the job read-backs spent the caller's own limb
// and the shared `agent:workspace` ceiling together, so an agent refused by its
// OWN budget still charged the ceiling on every retry — one looping agent could
// drain the budget every other agent of its workspace shares. The counts below
// are read straight off the shared Postgres store the production limiter uses.

const WINDOW_MS = 60_000;
const HEADROOM_MS = 5_000;
const SERVICE_SECRET = 'core-callback-secret-ceiling-after-own';
const ENVS = [
  'MOTIR_MCP_RATE_LIMIT',
  'MOTIR_MCP_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_INTERNAL_RATE_LIMIT',
  'MOTIR_AI_INTERNAL_RATE_LIMIT_WINDOW_MS',
  'MOTIR_API_V1_RATE_LIMIT',
  'MOTIR_API_V1_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT_WINDOW_MS',
] as const;

/** A limb under a test-only key, at `limit` per minute. */
function limb(key: string, limit: number): RateLimitLimb {
  return { scope: 'agent:workspace', key, budget: { limit, windowMs: WINDOW_MS } };
}

/** The ceiling's counter for `workspaceId` in the current window — null when no row exists. */
async function ceilingCount(workspaceId: string): Promise<number | null> {
  const { key } = agentWorkspaceLimb(workspaceId);
  const windowStart = currentWindowStart(agentWorkspaceBudget().windowMs);
  return rateLimitCounterRepository.findCountUnsafe(key, BigInt(windowStart));
}

/** One job read-back; `'served'` or `'refused'`. */
async function jobRead(token: string): Promise<'served' | 'refused'> {
  try {
    await authenticateAndLimitJobRequest(
      new Request('http://internal/api/internal/ai/get-item', {
        headers: { authorization: `Bearer ${SERVICE_SECRET}`, 'x-motir-job-token': token },
      }),
    );
    return 'served';
  } catch (err) {
    if (err instanceof JobRateLimitedError) return 'refused';
    throw err;
  }
}

/** One MCP transport request by agent `fingerprint`; true when admitted. */
async function mcpCall(workspaceId: string, fingerprint: string): Promise<boolean> {
  return (await enforceMcpRateLimit({ userId: 'u1', workspaceId }, fingerprint)).refusal === null;
}

const me = (headers: Record<string, string>) =>
  ME(new Request('http://localhost:3000/api/v1/me', { headers }));

beforeEach(async () => {
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  resetRateLimitStore();
  delete process.env[RATE_LIMIT_DISABLE_ENV];
  for (const name of ENVS) delete process.env[name];
  for (const name of ENVS) if (name.endsWith('_WINDOW_MS')) process.env[name] = String(WINDOW_MS);
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
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

describe('spendOwnThenShared (MOTIR-8610)', () => {
  it('never touches the shared limb when the own limb refuses', async () => {
    const spent: string[] = [];
    const inner = createInProcessRateLimitStore();
    const recording: RateLimitStore = {
      increment: (key, windowStart, windowMs) => {
        spent.push(key);
        return inner.increment(key, windowStart, windowMs);
      },
    };
    __setSharedRateLimitStoreForTest(recording);

    const own = limb('own', 1);
    const shared = limb('shared', 10);
    expect((await spendOwnThenShared(own, shared)).refused).toBeNull();
    spent.length = 0;

    const verdict = await spendOwnThenShared(own, shared);
    expect(spent).toEqual(['own']);
    expect(verdict.refused).not.toBeNull();
    expect(verdict.refused!.limit).toBe(1);
    expect(verdict.tightest).toBe(verdict.refused);
  });

  it('writes no counter row for the shared limb on the real store when the own limb refuses', async () => {
    const own = limb('own-pg', 1);
    await consumeSharedRateLimit(own.key, own.budget); // the own budget, spent elsewhere
    for (let i = 0; i < 3; i += 1) {
      expect((await spendOwnThenShared(own, limb('shared-pg', 10))).refused?.limit).toBe(1);
    }
    const windowStart = BigInt(currentWindowStart(WINDOW_MS));
    expect(await rateLimitCounterRepository.findCountUnsafe('shared-pg', windowStart)).toBeNull();
    expect(await rateLimitCounterRepository.findCountUnsafe('own-pg', windowStart)).toBe(4);
  });

  it('lets the shared limb refuse once the own limb admits, reporting the shared numbers', async () => {
    const shared = limb('shared-tight', 1);
    expect((await spendOwnThenShared(limb('a', 10), shared)).refused).toBeNull();
    const verdict = await spendOwnThenShared(limb('b', 10), shared);
    expect(verdict.refused?.limit).toBe(1);
    expect(verdict.tightest.limit).toBe(1);
  });

  it('reports the tighter limb when both admit', async () => {
    const verdict = await spendOwnThenShared(limb('own-wide', 100), limb('shared-narrow', 3));
    expect(verdict.refused).toBeNull();
    expect(verdict.tightest.limit).toBe(3);
    expect(verdict.tightest.remaining).toBe(2);
  });

  it('shapes a ceiling refusal as the retryable contract', async () => {
    const shared = limb('shared-contract', 1);
    await enforceRateLimitOwnThenShared(limb('x', 10), shared);
    const { response } = await enforceRateLimitOwnThenShared(limb('y', 10), shared);
    expect(response?.status).toBe(429);
    const body = (await response!.json()) as { code: string; retryAfterSeconds: number };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(response!.headers.get('Retry-After')).toBe(String(body.retryAfterSeconds));
    expect(response!.headers.get('x-ratelimit-limit')).toBe('1');
  });
});

describe('a throttled agent costs its workspace nothing (MOTIR-8610)', () => {
  beforeEach(() => {
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '10';
  });

  it('MCP: 50 calls from one agent over its own budget of 2 spend 2 of the ceiling', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '2';
    for (let i = 0; i < 50; i += 1) await mcpCall('w1', 'fp-looping');
    expect(await ceilingCount('w1')).toBe(2);
    for (let i = 0; i < 8; i += 1) expect(await mcpCall('w1', `fp-other-${i}`)).toBe(true);
    expect(await mcpCall('w1', 'fp-one-too-many')).toBe(false);
  }, 60_000);

  it('job read-backs: 50 reads from one job over its own budget of 2 spend 2 of the ceiling', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '2';
    const claims = { userId: 'u1', workspaceId: 'w1', projectId: 'p1' };
    const looping = mintJobToken(claims);
    for (let i = 0; i < 50; i += 1) await jobRead(looping);
    expect(await ceilingCount('w1')).toBe(2);
    for (let i = 0; i < 8; i += 1) expect(await jobRead(mintJobToken(claims))).toBe('served');
    expect(await jobRead(mintJobToken(claims))).toBe('refused');
  }, 60_000);

  it('/api/v1: 50 calls from one token over its own budget of 2 spend 2 of the ceiling', async () => {
    await truncateAuthTables();
    process.env['MOTIR_API_V1_RATE_LIMIT'] = '2';
    const looping = await createV1Caller();
    for (let i = 0; i < 50; i += 1) await me(looping.headers);
    expect(await ceilingCount(looping.workspace.id)).toBe(2);
    for (let i = 0; i < 8; i += 1) {
      const other = await withTokenFor(looping.user, looping.workspace);
      expect((await me(other.headers)).status).toBe(200);
    }
    const last = await withTokenFor(looping.user, looping.workspace);
    expect((await me(last.headers)).status).toBe(429);
  }, 60_000);

  it('across surfaces: a throttled MCP agent and a throttled job together spend only what they were admitted', async () => {
    process.env['MOTIR_MCP_RATE_LIMIT'] = '2';
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '2';
    const job = mintJobToken({ userId: 'u1', workspaceId: 'w1', projectId: 'p1' });
    for (let i = 0; i < 50; i += 1) {
      await mcpCall('w1', 'fp-looping');
      await jobRead(job);
    }
    expect(await ceilingCount('w1')).toBe(4);
    for (let i = 0; i < 6; i += 1) expect(await mcpCall('w1', `fp-fresh-${i}`)).toBe(true);
    expect(await mcpCall('w1', 'fp-past-the-ceiling')).toBe(false);
  }, 60_000);

  it('an MCP runaway leaves a job read and an /api/v1 call admitted in exactly the headroom left', async () => {
    await truncateAuthTables();
    process.env['MOTIR_MCP_RATE_LIMIT'] = '2';
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '4';
    const v1 = await createV1Caller();
    const ws = v1.workspace.id;
    for (let i = 0; i < 50; i += 1) await mcpCall(ws, 'fp-runaway');
    expect(await ceilingCount(ws)).toBe(2);
    expect(await jobRead(mintJobToken({ userId: 'u1', workspaceId: ws, projectId: 'p1' }))).toBe(
      'served',
    );
    expect((await me(v1.headers)).status).toBe(200);
    expect(await ceilingCount(ws)).toBe(4);
  }, 60_000);
});

describe("a ceiling refusal keeps each surface's contract shape (MOTIR-8610)", () => {
  beforeEach(() => {
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '1';
  });

  it('MCP: JSON-RPC 429 with data.code RATE_LIMITED and numeric retryAfterSeconds', async () => {
    expect(await mcpCall('w1', 'fp-a')).toBe(true);
    const { refusal } = await enforceMcpRateLimit({ userId: 'u1', workspaceId: 'w1' }, 'fp-b');
    expect(refusal?.status).toBe(429);
    const body = (await refusal!.json()) as {
      error: { data: { code: string; retryAfterSeconds: unknown } };
    };
    expect(body.error.data.code).toBe('RATE_LIMITED');
    expect(typeof body.error.data.retryAfterSeconds).toBe('number');
  });

  it('job read-back: JobRateLimitedError, a 429 RATE_LIMITED', async () => {
    const claims = { userId: 'u1', workspaceId: 'w1', projectId: 'p1' };
    expect(await jobRead(mintJobToken(claims))).toBe('served');
    const err = await authenticateAndLimitJobRequest(
      new Request('http://internal/api/internal/ai/get-item', {
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': mintJobToken(claims),
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobRateLimitedError);
    const response = (err as JobRateLimitedError).response;
    expect(response.status).toBe(429);
    expect(((await response.json()) as { code: string }).code).toBe('RATE_LIMITED');
  });

  it('/api/v1: 429 RATE_LIMIT_EXCEEDED with Retry-After', async () => {
    await truncateAuthTables();
    const first = await createV1Caller();
    expect((await me(first.headers)).status).toBe(200);
    const second = await withTokenFor(first.user, first.workspace);
    const res = await me(second.headers);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; retryAfterSeconds: number };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.headers.get('Retry-After')).toBe(String(body.retryAfterSeconds));
  });
});
