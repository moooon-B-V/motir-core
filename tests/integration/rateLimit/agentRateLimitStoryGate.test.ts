import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GET as V1_ME } from '@/app/api/v1/me/route';
import { db } from '@/lib/db';
import { authenticateAndLimitJobRequest, JobRateLimitedError } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { mintJobToken, verifyJobToken } from '@/lib/ai/jobToken';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { contextFromAuthInfo } from '@/lib/mcp/context';
import { billableToolDenial } from '@/lib/mcp/rateLimitGate';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import { enforceRateLimit, RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { enforceMcpRateLimit, MCP_RATE_LIMITED_JSONRPC_CODE } from '@/lib/rateLimit/mcpGuard';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { agentWorkspaceLimb } from '@/lib/rateLimit/workspaceCeiling';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createV1Caller, withTokenFor, type V1Caller } from '@/tests/fixtures/apiV1Fixtures';
import { truncateAuthTables, truncateRateLimitCounters } from '@/tests/helpers/db';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import {
  currentWindowStart,
  SUBPROCESS_HEADROOM_MS,
  SUBPROCESS_WINDOW_MS,
  waitForWindowHeadroom,
} from '@/tests/helpers/rateLimitWindow';

// ════════════════════════════════════════════════════════════════════════════
// STORY GATE — MOTIR-8548's motir-core half, criteria 2–7 (MOTIR-8607)
// ════════════════════════════════════════════════════════════════════════════
//
// Many agents of one person are served, not starved. Each of the story's cards
// proved its own limb alone; this file drives the ASSEMBLED limiter through the
// shipped entry points, against the worker's real Postgres store, the way many
// agents of one person reach it:
//
//   • MCP — `limitedHandler`'s per-request sequence: `verifyMcpToken` →
//     `contextFromAuthInfo` → `tokenFingerprint` → `enforceMcpRateLimit`;
//   • billable tools and the browser — `billableToolDenial`, `enforceAiRateLimit`;
//   • job read-backs — `authenticateAndLimitJobRequest` on a real `Request` with
//     the service bearer and a minted job token, refusals through
//     `mapJobRequestError`;
//   • `/api/v1` — the shipped `GET /api/v1/me` handler (`withV1Route`), real PATs.
//
// Budgets are pinned small through env and every case owns one window: the
// window is SUBPROCESS_WINDOW_MS (60 s) with SUBPROCESS_HEADROOM_MS of headroom,
// not ALIGNED_WINDOW_MS — the runaway case alone sends ~240 counted requests, two
// Postgres round trips each, which a 2 s cell cannot hold on a loaded runner.
//
// U = today's whole-user `mcp:call` budget, scaled: 10 (today's 300). The ratios
// the story names are kept; the absolute numbers are scaled down.
//
// ⚠️ THE JOB ARM IS SIZED FROM THE CODE, NOT FROM THE STORY'S TEXT. The story
// sized it at "6 internal reads per minute each", a fifth of the 30/min
// `aiBudget()`. On main, `ai:internal` already draws `aiInternalBudget()` — 600
// per `(workspace, user)` (MOTIR-8423) — so case 3's control is today's 600,
// scaled to 30.
//
// ⚠️ CASE 4 NO LONGER NEEDS TO STAY INSIDE THE CEILING. The card raised it as an
// open question whether a refused per-agent call should spend the workspace
// ceiling; MOTIR-8610 decided it does not (own-then-shared), so the runaway's 180
// refusals leave the ceiling untouched, and the counter rows below show it.

const WINDOW_MS = SUBPROCESS_WINDOW_MS;
const U = 10;
const SERVICE_SECRET = 'story-gate-8607-service-secret';

const ENVS = [
  'MOTIR_MCP_RATE_LIMIT',
  'MOTIR_MCP_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT',
  'MOTIR_AGENT_WORKSPACE_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_INTERNAL_RATE_LIMIT',
  'MOTIR_AI_INTERNAL_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_GENERATE_RATE_LIMIT',
  'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS',
  'MOTIR_AI_RATE_LIMIT',
  'MOTIR_AI_RATE_LIMIT_WINDOW_MS',
  'MOTIR_API_V1_RATE_LIMIT',
  'MOTIR_API_V1_RATE_LIMIT_WINDOW_MS',
  'CORE_CALLBACK_SECRET',
  'MOTIR_RATE_LIMIT_STORE',
  RATE_LIMIT_DISABLE_ENV,
] as const;
const saved: Record<string, string | undefined> = {};
for (const name of ENVS) saved[name] = process.env[name];

/** Pin `budgets` (limit per env name) on the case's window. */
function pin(budgets: Record<string, number>): void {
  for (const [name, limit] of Object.entries(budgets)) {
    process.env[name] = String(limit);
    process.env[`${name}_WINDOW_MS`] = String(WINDOW_MS);
  }
}

// ── the entry points ────────────────────────────────────────────────────────

interface Outcome {
  admitted: boolean;
  /** The refusal as the surface returns it, when refused. */
  refusal: Response | null;
}

/** One MCP request: `limitedHandler`'s sequence, up to the dispatch. */
async function mcpCall(bearer: string): Promise<Outcome> {
  const authInfo = await verifyMcpToken(
    new Request('http://localhost/api/mcp', { method: 'POST' }),
    bearer,
  );
  if (!authInfo) throw new Error('the fixture PAT did not verify');
  const { refusal } = await enforceMcpRateLimit(
    contextFromAuthInfo(authInfo),
    tokenFingerprint(authInfo.token),
  );
  return { admitted: refusal === null, refusal };
}

/** The ServiceContext MCP resolves for `bearer`. */
async function mcpContext(bearer: string): Promise<ServiceContext> {
  const authInfo = await verifyMcpToken(
    new Request('http://localhost/api/mcp', { method: 'POST' }),
    bearer,
  );
  return contextFromAuthInfo(authInfo!);
}

/** One job-token read-back, through the gate every `/api/internal/ai/*` route runs. */
async function jobRead(token: string): Promise<Outcome> {
  try {
    await authenticateAndLimitJobRequest(
      new Request('http://localhost/api/internal/ai/get-item?key=MOTIR-1', {
        headers: { authorization: `Bearer ${SERVICE_SECRET}`, 'x-motir-job-token': token },
      }),
    );
    return { admitted: true, refusal: null };
  } catch (err) {
    if (!(err instanceof JobRateLimitedError)) throw err;
    return { admitted: false, refusal: mapJobRequestError(err) };
  }
}

/** One `/api/v1` call on `caller`'s PAT. */
async function v1Call(caller: V1Caller): Promise<Outcome> {
  const res = await V1_ME(
    new Request('http://localhost:3000/api/v1/me', { headers: caller.headers }),
  );
  return { admitted: res.status === 200, refusal: res.status === 429 ? res : null };
}

/** One browser AI call (`/api/ai/*`'s guard). */
async function browserAi(ctx: ServiceContext, scope: 'ai:chat' | 'ai:generate'): Promise<Outcome> {
  const refusal = await enforceAiRateLimit(ctx, scope);
  return { admitted: refusal === null, refusal };
}

/** A job token of `ctx`'s user, carrying its own `jobKey`. */
function jobToken(ctx: { userId: string; workspaceId: string }): string {
  return mintJobToken({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: 'p1' });
}

/** A correctly signed job token with NO `jobKey` — one minted before MOTIR-8599. */
function keylessJobToken(ctx: { userId: string; workspaceId: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId: 'p1',
    iat: now,
    exp: now + 600,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', process.env['BETTER_AUTH_SECRET']!)
    .update(b64)
    .digest('base64url');
  return `${b64}.${sig}`;
}

const admittedOf = (outcomes: Outcome[]) => outcomes.filter((o) => o.admitted).length;

// ── the counter table ───────────────────────────────────────────────────────

let windowStart = BigInt(0);

/** The current window's count for `key`, read from `rate_limit_counter` (0 when no row). */
async function counted(key: string): Promise<number> {
  return (await rateLimitCounterRepository.findCountUnsafe(key, windowStart)) ?? 0;
}

const agentKey = (c: V1Caller) =>
  rateLimitKey('mcp:call', c.workspace.id, tokenFingerprint(c.token));
const ceilingKey = (workspaceId: string) => agentWorkspaceLimb(workspaceId).key;

/** Wait for a window with headroom, then record its start for the counter reads. */
async function ownWindow(): Promise<void> {
  await waitForWindowHeadroom(WINDOW_MS, SUBPROCESS_HEADROOM_MS);
  windowStart = BigInt(currentWindowStart(WINDOW_MS));
}

/** A user, a workspace, and `n` PATs of that user in it. */
async function agentsOfOneUser(n: number): Promise<V1Caller[]> {
  const first = await createV1Caller();
  const agents = [first];
  for (let i = 1; i < n; i += 1) agents.push(await withTokenFor(first.user, first.workspace));
  return agents;
}

// ── case 8's evidence: refusals taken from cases 4–6, never provoked apart ───

const refusals: Partial<
  Record<'mcpAgent' | 'mcpCeiling' | 'tool' | 'browser' | 'job' | 'v1', Response | CallToolResult>
> = {};

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  for (const name of ENVS) delete process.env[name];
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
});

afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  for (const name of ENVS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe('many agents of one person are served, not starved (MOTIR-8548, MOTIR-8607)', () => {
  it('1 — twenty agents of one user, U/5 calls each, are all served; 2 — today’s (workspace, user) key refuses them', async () => {
    pin({ MOTIR_MCP_RATE_LIMIT: 2 * U, MOTIR_AGENT_WORKSPACE_RATE_LIMIT: 40 * U });
    const agents = await agentsOfOneUser(20);
    await ownWindow();

    const outcomes: Outcome[] = [];
    for (const agent of agents) {
      for (let i = 0; i < U / 5; i += 1) outcomes.push(await mcpCall(agent.token));
    }
    expect(outcomes).toHaveLength(40);
    expect(admittedOf(outcomes)).toBe(40);

    // Case 9 — every one of the 40 reached the table: no decision failed open.
    for (const agent of agents) expect(await counted(agentKey(agent))).toBe(U / 5);
    expect(await counted(ceilingKey(agents[0]!.workspace.id))).toBe(40);

    // Case 2 — the CONTROL ARM: the same 40 calls through today's shipped key and
    // budget, rebuilt. Exactly U are admitted: the harness can see the starvation.
    const ctx = await mcpContext(agents[0]!.token);
    const today = {
      scope: 'mcp:call' as const,
      key: rateLimitKey('mcp:call', ctx.workspaceId, ctx.userId),
      budget: { limit: U, windowMs: WINDOW_MS },
    };
    const control: Outcome[] = [];
    for (let i = 0; i < 40; i += 1) {
      const { response } = await enforceRateLimit([today]);
      control.push({ admitted: response === null, refusal: response });
    }
    expect(admittedOf(control)).toBe(U);
    expect(control.length - admittedOf(control)).toBe(30);
    expect(await counted(today.key)).toBe(40);
  }, 120_000);

  it('3 — twenty jobs of one user, 6 reads each, are all served; today’s per-user key admits 30', async () => {
    pin({ MOTIR_AI_INTERNAL_RATE_LIMIT: 30, MOTIR_AGENT_WORKSPACE_RATE_LIMIT: 40 * U });
    const owner = await createV1Caller();
    const ctx = { userId: owner.user.id, workspaceId: owner.workspace.id };
    const tokens = Array.from({ length: 20 }, () => jobToken(ctx));
    expect(new Set(tokens.map((t) => verifyJobToken(t)!.jobKey)).size).toBe(20);
    await ownWindow();

    const outcomes: Outcome[] = [];
    for (const token of tokens) for (let i = 0; i < 6; i += 1) outcomes.push(await jobRead(token));
    expect(admittedOf(outcomes)).toBe(120);
    // Case 9 — counted, per job and on the ceiling.
    for (const token of tokens) {
      expect(
        await counted(rateLimitKey('ai:job', ctx.workspaceId, verifyJobToken(token)!.jobKey!)),
      ).toBe(6);
    }
    expect(await counted(ceilingKey(ctx.workspaceId))).toBe(120);

    // The control arm: today's per-user `ai:internal` key at today's 600, scaled.
    const today = {
      scope: 'ai:internal' as const,
      key: rateLimitKey('ai:internal', ctx.workspaceId, ctx.userId),
      budget: { limit: 30, windowMs: WINDOW_MS },
    };
    const control: Outcome[] = [];
    for (let i = 0; i < 120; i += 1) {
      const { response } = await enforceRateLimit([today]);
      control.push({ admitted: response === null, refusal: response });
    }
    expect(admittedOf(control)).toBe(30);
  }, 120_000);

  it('4 — a runaway agent is held at its own budget; the other agents and the browser are served', async () => {
    pin({
      MOTIR_MCP_RATE_LIMIT: 2 * U,
      MOTIR_AGENT_WORKSPACE_RATE_LIMIT: 40 * U,
      MOTIR_AI_RATE_LIMIT: 5,
      MOTIR_AI_GENERATE_RATE_LIMIT: 5,
    });
    const agents = await agentsOfOneUser(20);
    const [runaway, ...others] = agents;
    const browser = await mcpContext(runaway!.token);
    await ownWindow();

    const runawayOutcomes: Outcome[] = [];
    for (let i = 0; i < 10 * 2 * U; i += 1) runawayOutcomes.push(await mcpCall(runaway!.token));
    const otherOutcomes: Outcome[] = [];
    for (const agent of others) {
      for (let i = 0; i < U / 5; i += 1) otherOutcomes.push(await mcpCall(agent.token));
    }
    const chat = await browserAi(browser, 'ai:chat');
    const generate = await browserAi(browser, 'ai:generate');

    expect(admittedOf(runawayOutcomes)).toBe(2 * U);
    expect(runawayOutcomes.length - admittedOf(runawayOutcomes)).toBe(180);
    expect(runawayOutcomes.slice(2 * U).every((o) => !o.admitted)).toBe(true);
    expect(admittedOf(otherOutcomes)).toBe(otherOutcomes.length);
    expect(chat.admitted).toBe(true);
    expect(generate.admitted).toBe(true);
    refusals.mcpAgent = runawayOutcomes.at(-1)!.refusal!;

    // Case 9 — the runaway's 200 calls all reached its own row; the ceiling holds
    // only what an agent's own limb admitted (MOTIR-8610): 20 + 19 × 2.
    expect(await counted(agentKey(runaway!))).toBe(200);
    expect(await counted(ceilingKey(runaway!.workspace.id))).toBe(2 * U + 19 * (U / 5));
    expect(await counted(rateLimitKey('ai:chat', browser.workspaceId, browser.userId))).toBe(1);
    expect(await counted(rateLimitKey('ai:generate', browser.workspaceId, browser.userId))).toBe(1);
  }, 120_000);

  it('5 — minting tokens does not widen the workspace ceiling, across MCP, /api/v1 and job reads', async () => {
    pin({ MOTIR_MCP_RATE_LIMIT: 100, MOTIR_AGENT_WORKSPACE_RATE_LIMIT: 30 });
    const agents = await agentsOfOneUser(60);
    const v1Agents: V1Caller[] = [];
    for (let i = 0; i < 5; i += 1) {
      v1Agents.push(await withTokenFor(agents[0]!.user, agents[0]!.workspace));
    }
    const elsewhere = await createV1Caller({ workspaceName: 'Elsewhere' });
    const ws = agents[0]!.workspace.id;
    await ownWindow();

    const mcp: Outcome[] = [];
    for (const agent of agents) mcp.push(await mcpCall(agent.token));
    expect(admittedOf(mcp)).toBe(30);
    expect(mcp.slice(30).every((o) => !o.admitted)).toBe(true);
    refusals.mcpCeiling = mcp.at(-1)!.refusal!;

    // The same bucket refuses the other two surfaces in this workspace…
    const v1: Outcome[] = [];
    for (const caller of v1Agents) v1.push(await v1Call(caller));
    expect(admittedOf(v1)).toBe(0);
    expect(v1.every((o) => o.refusal?.status === 429)).toBe(true);
    refusals.v1 = v1.at(-1)!.refusal!;
    const job = await jobRead(jobToken({ userId: agents[0]!.user.id, workspaceId: ws }));
    expect(job.admitted).toBe(false);
    refusals.job = job.refusal!;

    // …and leaves another workspace alone, on all three.
    expect((await mcpCall(elsewhere.token)).admitted).toBe(true);
    expect((await v1Call(elsewhere)).admitted).toBe(true);
    expect(
      (await jobRead(jobToken({ userId: elsewhere.user.id, workspaceId: elsewhere.workspace.id })))
        .admitted,
    ).toBe(true);

    // The ceiling, read back from the table: every request whose own limb admitted
    // spent it — 60 MCP, 5 v1, 1 job read — and the first 30 were the admitted.
    expect(await counted(ceilingKey(ws))).toBe(60 + 5 + 1);
    expect(await counted(ceilingKey(elsewhere.workspace.id))).toBe(3);
  }, 120_000);

  it('6 — money is unchanged: two PATs and the browser of one user share one AI bucket', async () => {
    pin({ MOTIR_AI_GENERATE_RATE_LIMIT: 2, MOTIR_AI_RATE_LIMIT: 2 });
    const [a, b] = await agentsOfOneUser(2);
    const ctxA = await mcpContext(a!.token);
    const ctxB = await mcpContext(b!.token);
    const browser: ServiceContext = { userId: ctxA.userId, workspaceId: ctxA.workspaceId };
    const secondUser: ServiceContext = { ...browser, userId: `${browser.userId}-teammate` };
    await ownWindow();

    // ai:generate — the billable tool on PAT A, then on PAT B, then the browser.
    expect(await billableToolDenial('expand_item', ctxA)).toBeNull();
    expect(await billableToolDenial('expand_item', ctxB)).toBeNull();
    const browserGenerate = await browserAi(browser, 'ai:generate');
    expect(browserGenerate.admitted).toBe(false);
    refusals.browser = browserGenerate.refusal!;
    const toolRefused = await billableToolDenial('expand_item', ctxA);
    expect(toolRefused).not.toBeNull();
    refusals.tool = toolRefused!;
    expect((await browserAi(secondUser, 'ai:generate')).admitted).toBe(true);

    // ai:chat — the same shape: the key is the person, not the credential.
    expect((await browserAi(ctxA, 'ai:chat')).admitted).toBe(true);
    expect((await browserAi(ctxB, 'ai:chat')).admitted).toBe(true);
    expect((await browserAi(browser, 'ai:chat')).admitted).toBe(false);
    expect((await browserAi(secondUser, 'ai:chat')).admitted).toBe(true);

    // Case 9 — one (workspace, user) row per scope, holding every call.
    expect(await counted(rateLimitKey('ai:generate', browser.workspaceId, browser.userId))).toBe(4);
    expect(await counted(rateLimitKey('ai:chat', browser.workspaceId, browser.userId))).toBe(3);
  }, 120_000);

  it('7 — at default budgets, two jobs at 100 reads/min each and a keyless token’s 100 are all served', async () => {
    const owner = await createV1Caller();
    const ctx = { userId: owner.user.id, workspaceId: owner.workspace.id };
    const jobs = [jobToken(ctx), jobToken(ctx)];
    const keyless = keylessJobToken(ctx);
    expect(verifyJobToken(keyless)!.jobKey ?? null).toBeNull();
    // The real 60 s window; the 300 reads must all land in one cell.
    await waitForWindowHeadroom(60_000, 30_000);
    windowStart = BigInt(currentWindowStart(60_000));

    const outcomes: Outcome[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      outcomes.push(
        ...(await Promise.all(Array.from({ length: 20 }, (_, i) => jobRead(jobs[i % 2]!)))),
      );
    }
    expect(outcomes).toHaveLength(200);
    expect(admittedOf(outcomes)).toBe(200);
    const keylessOutcomes: Outcome[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      keylessOutcomes.push(
        ...(await Promise.all(Array.from({ length: 10 }, () => jobRead(keyless)))),
      );
    }
    expect(admittedOf(keylessOutcomes)).toBe(100);

    // Case 9 — counted on the job's own buckets and the separate keyless one.
    for (const token of jobs) {
      expect(
        await counted(rateLimitKey('ai:job', ctx.workspaceId, verifyJobToken(token)!.jobKey!)),
      ).toBe(100);
    }
    expect(await counted(rateLimitKey('ai:internal', ctx.workspaceId, ctx.userId))).toBe(100);
  }, 180_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 8 — EVERY REFUSAL ABOVE IS MACHINE-RETRYABLE (story criterion 7)
// ════════════════════════════════════════════════════════════════════════════
//
// One row per surface, asserted on a refusal TAKEN from cases 4–6. Runs after
// them (this file's tests are sequential); a row whose case did not run fails.

const positiveInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1;

describe('8 — every refusal the gate produced is machine-retryable', () => {
  async function httpBody(res: Response) {
    const body = (await res.clone().json()) as Record<string, unknown>;
    return { body, retryAfter: res.headers.get('Retry-After') };
  }

  it.each(['mcpAgent', 'mcpCeiling'] as const)(
    'MCP %s: 429, JSON-RPC error with data.retryAfterSeconds = Retry-After',
    async (row) => {
      const res = refusals[row] as Response | undefined;
      expect(res, `case ${row === 'mcpAgent' ? 4 : 5} did not run`).toBeDefined();
      expect(res!.status).toBe(429);
      const { body, retryAfter } = await httpBody(res!);
      const error = body['error'] as {
        code: number;
        data: { code: string; retryAfterSeconds: unknown };
      };
      expect(error.code).toBe(MCP_RATE_LIMITED_JSONRPC_CODE);
      expect(error.data.code).toBe(RATE_LIMITED_CODE);
      expect(positiveInt(error.data.retryAfterSeconds)).toBe(true);
      expect(error.data.retryAfterSeconds).toBe(Number(retryAfter));
    },
  );

  it('billable tool: isError with structuredContent { code: RATE_LIMITED, retryAfterSeconds ≥ 1 }', () => {
    const result = refusals.tool as CallToolResult | undefined;
    expect(result, 'case 6 did not run').toBeDefined();
    expect(result!.isError).toBe(true);
    const content = result!.structuredContent as { code: string; retryAfterSeconds: unknown };
    expect(content.code).toBe(RATE_LIMITED_CODE);
    expect(positiveInt(content.retryAfterSeconds)).toBe(true);
  });

  it.each(['browser', 'job'] as const)(
    '%s: 429, body code RATE_LIMITED, retryAfterSeconds = Retry-After',
    async (row) => {
      const res = refusals[row] as Response | undefined;
      expect(res, `case ${row === 'browser' ? 6 : 5} did not run`).toBeDefined();
      expect(res!.status).toBe(429);
      const { body, retryAfter } = await httpBody(res!);
      expect(body['code']).toBe(RATE_LIMITED_CODE);
      expect(positiveInt(body['retryAfterSeconds'])).toBe(true);
      expect(body['retryAfterSeconds']).toBe(Number(retryAfter));
    },
  );

  it('/api/v1 ceiling: 429, v1’s frozen RATE_LIMIT_EXCEEDED, retryAfterSeconds = Retry-After, X-RateLimit-*', async () => {
    const res = refusals.v1 as Response | undefined;
    expect(res, 'case 5 did not run').toBeDefined();
    expect(res!.status).toBe(429);
    const { body, retryAfter } = await httpBody(res!);
    expect(body['code']).toBe('RATE_LIMIT_EXCEEDED');
    expect(positiveInt(body['retryAfterSeconds'])).toBe(true);
    expect(body['retryAfterSeconds']).toBe(Number(retryAfter));
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      expect(res!.headers.get(h), h).toBeTruthy();
    }
  });
});
