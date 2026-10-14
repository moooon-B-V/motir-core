import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  authenticateAndLimitJobRequest,
  JobAuthError,
  JobRateLimitedError,
} from '@/lib/ai/jobAuth';
import { mintJobToken, refreshJobToken, verifyJobToken } from '@/lib/ai/jobToken';
import { consumeSharedRateLimit, RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { enforceMcpRateLimit } from '@/lib/rateLimit/mcpGuard';
import { agentWorkspaceLimb } from '@/lib/rateLimit/workspaceCeiling';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { waitForWindowHeadroom } from '@/tests/helpers/rateLimitWindow';

// Job-token read-backs metered PER JOB (MOTIR-8604, Story MOTIR-8548).
//
// Every `/api/internal/ai/*` route funnels through `authenticateAndLimitJobRequest`,
// so these cases drive that one seam with real signed tokens, on the shared
// Postgres store the production limiter counts through. Two limbs: the job's
// own bucket (`ai:job` on the token's `jobKey`; a keyless token keeps the old
// `(workspace, user)` `ai:internal` bucket) and the workspace's shared agent
// ceiling, which MCP and `/api/v1` spend too.

const SERVICE_SECRET = 'core-callback-secret-job-reads';
const WINDOW_MS = 60_000;
const HEADROOM_MS = 5_000;
const ENVS = [
  'MOTIR_AI_INTERNAL_RATE_LIMIT',
  'MOTIR_AI_INTERNAL_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT_WINDOW_MS',
  'MOTIR_MCP_RATE_LIMIT',
  'MOTIR_MCP_RATE_LIMIT_WINDOW_MS',
] as const;

function claims(workspaceId: string, userId = 'u1') {
  return { userId, workspaceId, projectId: 'p1' };
}

function request(token: string | null, bearer = SERVICE_SECRET): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  if (token !== null) headers['x-motir-job-token'] = token;
  return new Request('http://internal/api/internal/ai/get-item', { headers });
}

/** A correctly signed token with NO `jobKey` — one minted before MOTIR-8599. */
function keylessToken(workspaceId: string, userId = 'u1'): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: userId, workspaceId, projectId: 'p1', iat: now, exp: now + 600 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', process.env['BETTER_AUTH_SECRET']!)
    .update(b64)
    .digest('base64url');
  return `${b64}.${sig}`;
}

/** Read once; resolves `'served'` or `'refused'`, rethrowing anything else. */
async function read(token: string): Promise<'served' | 'refused'> {
  try {
    await authenticateAndLimitJobRequest(request(token));
    return 'served';
  } catch (err) {
    if (err instanceof JobRateLimitedError) {
      expect(err.httpStatus).toBe(429);
      expect(err.response.status).toBe(429);
      return 'refused';
    }
    throw err;
  }
}

/** How many of the ceiling's requests `workspaceId` has left, by spending one. */
async function ceilingRemainingAfterOneMore(workspaceId: string): Promise<number> {
  const limb = agentWorkspaceLimb(workspaceId);
  return (await consumeSharedRateLimit(limb.key, limb.budget)).remaining;
}

beforeEach(async () => {
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  delete process.env[RATE_LIMIT_DISABLE_ENV];
  for (const name of ENVS) delete process.env[name];
  for (const name of ENVS) if (name.endsWith('_WINDOW_MS')) process.env[name] = String(WINDOW_MS);
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await waitForWindowHeadroom(WINDOW_MS, HEADROOM_MS);
});

afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  for (const name of ENVS) delete process.env[name];
});

afterAll(async () => {
  await db.$disconnect();
});

describe('job read-backs are metered per job (MOTIR-8604)', () => {
  it('gives two jobs of one person a bucket each', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '1';
    const jobA = mintJobToken(claims('w1'));
    const jobB = mintJobToken(claims('w1'));
    expect(verifyJobToken(jobA)!.jobKey).not.toBe(verifyJobToken(jobB)!.jobKey);

    expect(await read(jobA)).toBe('served');
    expect(await read(jobB)).toBe('served');
    expect(await read(jobA)).toBe('refused');
    expect(await read(jobB)).toBe('refused');
  });

  it('a token and its refreshed successor draw ONE budget', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '1';
    const original = mintJobToken(claims('w1'));
    const renewed = refreshJobToken(verifyJobToken(original)!);
    expect(await read(original)).toBe('served');
    expect(await read(renewed)).toBe('refused');
  });

  it('keyless tokens share the old person bucket, apart from keyed jobs, and are never unlimited', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '1';
    const keyed = mintJobToken(claims('w1'));
    expect(await read(keyed)).toBe('served');
    // The keyed job's spent budget is not the keyless bucket.
    expect(await read(keylessToken('w1'))).toBe('served');
    // A second keyless token of the same person shares that one bucket.
    expect(await read(keylessToken('w1'))).toBe('refused');
  });

  it('holds every job of a workspace under the shared ceiling', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '100';
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '2';
    expect(await read(mintJobToken(claims('w1')))).toBe('served');
    expect(await read(mintJobToken(claims('w1')))).toBe('served');
    expect(await read(mintJobToken(claims('w1')))).toBe('refused');
    expect(await read(mintJobToken(claims('w2')))).toBe('served');
  });

  it('shares that ceiling with the MCP transport — one bucket for both surfaces', async () => {
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '100';
    process.env['MOTIR_MCP_RATE_LIMIT'] = '100';
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '2';
    const ctx = { userId: 'u1', workspaceId: 'w1' };
    expect((await enforceMcpRateLimit(ctx, 'fp-agent')).refusal).toBeNull();
    expect(await read(mintJobToken(claims('w1')))).toBe('served');
    expect(await read(mintJobToken(claims('w1')))).toBe('refused');
  });

  it('serves one job 100 consecutive reads at the default budgets', async () => {
    const job = mintJobToken(claims('w1'));
    for (let i = 0; i < 100; i += 1) expect(await read(job)).toBe('served');
  }, 60_000);

  it('authenticates FIRST: a failed auth throws 401 and spends neither limb', async () => {
    process.env['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '10';
    const job = mintJobToken(claims('w1'));
    for (const bad of [request(job, 'wrong-bearer'), request(null)]) {
      await expect(authenticateAndLimitJobRequest(bad)).rejects.toBeInstanceOf(JobAuthError);
    }
    // Nothing was spent: the first counted request leaves 9 of 10.
    expect(await ceilingRemainingAfterOneMore('w1')).toBe(9);
    // …and the job's own bucket is untouched too.
    process.env['MOTIR_AI_INTERNAL_RATE_LIMIT'] = '1';
    expect(await read(job)).toBe('served');
  });
});
