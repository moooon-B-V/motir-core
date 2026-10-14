import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mintJobToken } from '@/lib/ai/jobToken';
import { withV1Route } from '@/lib/api/v1/route';
import { classifyApiV1Error } from '@/lib/api/v1/errors';
import { RateLimitExceededError, resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { v1ErrorBodySchema } from '@/lib/api/v1/openapi/errorResponse';
import { billableToolDenial, refusalRetryAfterSeconds } from '@/lib/mcp/rateLimitGate';
import { rateLimitedToolError } from '@/lib/mcp/toolResult';
import { createInProcessRateLimitStore } from '@/lib/api/v1/rateLimit';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { enforceMcpRateLimit, MCP_RATE_LIMITED_JSONRPC_CODE } from '@/lib/rateLimit/mcpGuard';
import {
  __resetSharedRateLimitStoreForTest,
  __setSharedRateLimitStoreForTest,
} from '@/lib/rateLimit/store';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createV1Caller } from '../fixtures/apiV1Fixtures';
import { db } from '@/lib/db';
import { truncateAuthTables } from '../helpers/db';
import { waitForWindowHeadroom } from '../helpers/rateLimitWindow';

// THE RETRYABLE REFUSAL CONTRACT (MOTIR-8600), asserted on every surface at once.
//
// Every rate-limit refusal an agent can meet carries a whole-number
// `retryAfterSeconds` a client reads without parsing a sentence, and every HTTP
// refusal also carries `Retry-After` with the same number. The contract is
// written once, in `lib/rateLimit/guard.ts`; this file drives each surface to a
// REAL refusal through its shipped entry point, with a budget of 1.
//
// ⚠️ A FIFTH SURFACE JOINS THE TABLE. If you add an agent-reachable refusal,
// add its row to `SURFACES` below — the table is the contract's inventory.

/** What a client reads off a refusal, whatever surface produced it. */
interface Refusal {
  /** The code a client branches on. */
  code: string;
  /** The machine-read seconds. */
  retryAfterSeconds: unknown;
  /** The `Retry-After` header, or `null` where the transport is not HTTP. */
  retryAfterHeader: string | null;
  /** The HTTP status, or `null` for an in-band tool result. */
  status: number | null;
}

const WINDOW_MS = 60_000;
/** Enough of the window left that a pair of calls cannot straddle a boundary. */
const HEADROOM_MS = 5_000;

const ctx: ServiceContext = { userId: 'contract_user', workspaceId: 'contract_ws' };
const SERVICE_SECRET = 'core-callback-secret-contract';

const BUDGET_ENVS = [
  'MOTIR_MCP_RATE_LIMIT',
  'MOTIR_MCP_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_GENERATE_RATE_LIMIT',
  'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_INTERNAL_RATE_LIMIT',
  'MOTIR_AI_INTERNAL_RATE_LIMIT_WINDOW_MS',
  'MOTIR_API_V1_RATE_LIMIT',
  'MOTIR_API_V1_RATE_LIMIT_WINDOW_MS',
] as const;

async function mcpTransport(): Promise<Refusal> {
  await enforceMcpRateLimit(ctx, 'fp-contract');
  const { refusal } = await enforceMcpRateLimit(ctx, 'fp-contract');
  expect(refusal).not.toBeNull();
  const body = (await refusal!.json()) as {
    error: { code: number; data: { code: string; retryAfterSeconds: unknown } };
  };
  // Pinned unchanged: the JSON-RPC envelope and its error code.
  expect(body.error.code).toBe(MCP_RATE_LIMITED_JSONRPC_CODE);
  return {
    code: body.error.data.code,
    retryAfterSeconds: body.error.data.retryAfterSeconds,
    retryAfterHeader: refusal!.headers.get('Retry-After'),
    status: refusal!.status,
  };
}

async function billableTool(): Promise<Refusal> {
  expect(await billableToolDenial('expand_item', ctx)).toBeNull();
  const denied = await billableToolDenial('expand_item', ctx);
  expect(denied?.isError).toBe(true);
  // The prose still leads with the code — a person watching reads it.
  const text = (denied!.content[0] as { text: string }).text;
  expect(text.startsWith(`${RATE_LIMITED_CODE}: `)).toBe(true);
  const structured = denied!.structuredContent as { code: string; retryAfterSeconds: unknown };
  expect(Object.keys(structured).sort()).toEqual(['code', 'retryAfterSeconds']);
  return {
    code: structured.code,
    retryAfterSeconds: structured.retryAfterSeconds,
    retryAfterHeader: null,
    status: null,
  };
}

async function jobTokenRoute(): Promise<Refusal> {
  const token = mintJobToken({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: 'p' });
  const request = () =>
    new Request('http://internal/api/internal/ai/plan-tree', {
      headers: { authorization: `Bearer ${SERVICE_SECRET}`, 'x-motir-job-token': token },
    });
  await authenticateAndLimitJobRequest(request());
  let response: Response | null = null;
  try {
    await authenticateAndLimitJobRequest(request());
  } catch (err) {
    // The error's own shape is unchanged.
    expect((err as { code?: string }).code).toBe('RATE_LIMITED');
    expect((err as { httpStatus?: number }).httpStatus).toBe(429);
    response = mapJobRequestError(err);
  }
  expect(response).not.toBeNull();
  const body = (await response!.json()) as { code: string; retryAfterSeconds: unknown };
  expect(response!.headers.get('x-ratelimit-limit')).toBe('1');
  expect(response!.headers.get('x-ratelimit-remaining')).toBe('0');
  expect(response!.headers.get('x-ratelimit-reset')).toBeTruthy();
  return {
    code: body.code,
    retryAfterSeconds: body.retryAfterSeconds,
    retryAfterHeader: response!.headers.get('Retry-After'),
    status: response!.status,
  };
}

async function v1Route(): Promise<Refusal> {
  const caller = await createV1Caller();
  const route = withV1Route({ permission: 'project:browse' }, () =>
    NextResponse.json({ ok: true }),
  );
  const request = () => new Request('http://localhost:3000/api/v1/x', { headers: caller.headers });
  expect((await route(request())).status).toBe(200);
  const refused = await route(request());
  const body = (await refused.json()) as { code: string; retryAfterSeconds: unknown };
  // The published body still parses against the document's schema.
  expect(() => v1ErrorBodySchema.parse(body)).not.toThrow();
  expect(refused.headers.get('x-ratelimit-limit')).toBe('1');
  expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
  expect(refused.headers.get('x-ratelimit-reset')).toBeTruthy();
  return {
    code: body.code,
    retryAfterSeconds: body.retryAfterSeconds,
    retryAfterHeader: refused.headers.get('Retry-After'),
    status: refused.status,
  };
}

/**
 * The four agent-reachable refusals and the code each carries. v1 keeps its
 * published `RATE_LIMIT_EXCEEDED` — changing a v1 code is breaking under
 * `public-api-conventions.md` §8.
 */
const SURFACES: ReadonlyArray<{
  surface: string;
  code: string;
  http: boolean;
  refuse: () => Promise<Refusal>;
}> = [
  {
    surface: 'MCP transport (POST /api/mcp)',
    code: 'RATE_LIMITED',
    http: true,
    refuse: mcpTransport,
  },
  { surface: 'billable MCP tool result', code: 'RATE_LIMITED', http: false, refuse: billableTool },
  {
    surface: 'job-token route (/api/internal/ai/*)',
    code: 'RATE_LIMITED',
    http: true,
    refuse: jobTokenRoute,
  },
  { surface: '/api/v1 route', code: 'RATE_LIMIT_EXCEEDED', http: true, refuse: v1Route },
];

beforeEach(async () => {
  await truncateAuthTables();
  // Fresh in-process counters for both stores: the app-level limiters' and v1's.
  __setSharedRateLimitStoreForTest(createInProcessRateLimitStore());
  resetRateLimitStore();
  delete process.env[RATE_LIMIT_DISABLE_ENV];
  for (const name of BUDGET_ENVS) {
    process.env[name] = name.endsWith('_WINDOW_MS') ? String(WINDOW_MS) : '1';
  }
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await waitForWindowHeadroom(WINDOW_MS, HEADROOM_MS);
});

afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  resetRateLimitStore();
  for (const name of BUDGET_ENVS) delete process.env[name];
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the retryable refusal contract (MOTIR-8600)', () => {
  it.each(SURFACES)(
    '$surface refuses with a numeric retryAfterSeconds',
    async ({ code, http, refuse }) => {
      const refusal = await refuse();
      expect(refusal.code).toBe(code);
      expect(typeof refusal.retryAfterSeconds).toBe('number');
      expect(Number.isInteger(refusal.retryAfterSeconds)).toBe(true);
      expect(refusal.retryAfterSeconds as number).toBeGreaterThanOrEqual(1);
      expect(refusal.retryAfterSeconds as number).toBeLessThanOrEqual(WINDOW_MS / 1000);
      if (http) {
        expect(refusal.status).toBe(429);
        expect(Number(refusal.retryAfterHeader)).toBe(refusal.retryAfterSeconds);
      } else {
        expect(refusal.status).toBeNull();
      }
    },
    30_000,
  );

  it('a v1 401 still exits before the limiter and carries neither half', async () => {
    const route = withV1Route({ permission: 'project:browse' }, () =>
      NextResponse.json({ ok: true }),
    );
    const res = await route(new Request('http://localhost:3000/api/v1/x'));
    expect(res.status).toBe(401);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    expect(await res.json()).not.toHaveProperty('retryAfterSeconds');
  });
});

describe('where the tool refusal takes its seconds from', () => {
  it('reads the body field as a number, ahead of the header', async () => {
    const refusal = new Response(JSON.stringify({ code: 'RATE_LIMITED', retryAfterSeconds: 7 }), {
      status: 429,
      headers: { 'Retry-After': '9' },
    });
    expect(await refusalRetryAfterSeconds(refusal)).toBe(7);
  });

  it('falls back to the Retry-After header — never to the sentence', async () => {
    const refusal = new Response(
      JSON.stringify({ code: 'RATE_LIMITED', error: 'Too many requests. Retry in 99 seconds.' }),
      { status: 429, headers: { 'Retry-After': '12' } },
    );
    expect(await refusalRetryAfterSeconds(refusal)).toBe(12);
  });

  it('floors a refusal carrying neither at 1 — wait, never hammer', async () => {
    const refusal = new Response('not json', { status: 429 });
    expect(await refusalRetryAfterSeconds(refusal)).toBe(1);
  });

  it('builds the tool error with the code and seconds in structuredContent', () => {
    expect(rateLimitedToolError(3, 'Slow down.')).toEqual({
      content: [{ type: 'text', text: 'RATE_LIMITED: Slow down.' }],
      isError: true,
      structuredContent: { code: 'RATE_LIMITED', retryAfterSeconds: 3 },
    });
  });
});

describe('the v1 classifier', () => {
  it('carries retryAfterSeconds from a RateLimitExceededError, and the code is unchanged', () => {
    expect(classifyApiV1Error(new RateLimitExceededError(4))).toEqual({
      status: 429,
      body: {
        code: 'RATE_LIMIT_EXCEEDED',
        error: 'Rate limit exceeded. Retry in 4 seconds.',
        retryAfterSeconds: 4,
      },
    });
  });
});
