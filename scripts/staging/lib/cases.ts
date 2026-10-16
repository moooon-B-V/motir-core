import { randomUUID } from 'node:crypto';
import { attributePair, type Machine, type PinnedClient, type Served } from './pinnedClient';

// THE CASE LIST, AGAINST A DEPLOYED APP (Story MOTIR-8547 · MOTIR-8620).
//
// ⚠️ A DOCUMENTED COPY of the local lane's cases, not a shared module. The local
// specs (`tests/two-instance/limits.spec.ts`, `followups.spec.ts`) cannot be
// lifted mechanically, for two reasons that are properties of staging, not of
// taste:
//
//   - IDENTITY. Locally each sequence spoofs a fresh client IP in a SINGLE-value
//     `x-forwarded-for`, which Better-Auth 1.7.7 trusts only when it is single
//     (`@better-auth/core` `utils/ip.mjs` `getIPFromHeader`, no `trustedProxies`
//     configured in `lib/auth/index.ts`). Behind Fly the proxy APPENDS the real
//     client address, so a spoofed header arrives two-valued, Better-Auth
//     resolves no IP, and the request lands in ONE shared `no-trusted-ip|<path>`
//     bucket. So this script sends NO `x-forwarded-for`: Fly sets it to the
//     runner's own address, single-valued, and that is the identity both
//     Better-Auth and `lib/rateLimit/keys.ts` (first hop of the same header) key
//     on. The consequence is that a bucket is the RUNNER's for its whole window.
//   - SEEDING. Locally the fixtures write users, tokens and plans through the
//     app's services in-process. Here there is no database access: everything is
//     seeded over HTTP with the dedicated test account's credentials.
//
// Every assertion the local cases make is made here too; none is loosened. The
// differences are listed beside each case.

/** A case that failed an assertion — a product failure, exit 1. */
export class CaseFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaseFailure';
  }
}

/** A bucket already spent by an earlier run — not a product failure, exit 3. */
export class PreSpentBucketError extends Error {
  constructor(
    readonly bucket: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(
      `the ${bucket} bucket is already spent for this runner (call 1 was 429); ` +
        `retry after ${retryAfterSeconds ?? '?'} s`,
    );
    this.name = 'PreSpentBucketError';
  }
}

export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly pass: boolean;
  /** The machine id that served the case's first request of the pair it judges. */
  readonly first: string | null;
  readonly second: string | null;
  readonly statuses: number[];
  readonly detail: string;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
  readonly pat: string;
  readonly projectKey: string;
  /** The `origin` header Better-Auth and the cookie routes check (a trusted origin). */
  readonly origin: string;
}

/**
 * The workbench stream's coalescing window — `app/api/workbench/stream/route.ts`,
 * pinned by a test. A write is pushed (MOTIR-8729), so a frame follows it after
 * this window plus one read.
 */
export const WORKBENCH_STREAM_COALESCE_MS = 250;
export const WORKBENCH_STREAM_FRAME = 'watermark';
/** The CLI's device-flow client id — `lib/cliDevice/constants.ts`, pinned by a test. */
export const CLI_CLIENT_ID = 'motir-cli';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CaseFailure(message);
}

/** Fail with the body in the message — read ONLY on failure, so a pass can still read it. */
async function expectStatus(served: Served, status: number, what: string): Promise<void> {
  if (served.response.status === status) return;
  const body = await served.response.text().catch(() => '');
  throw new CaseFailure(`${what} answered ${served.response.status}: ${body.slice(0, 300)}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * The server's clock, as read off a `date` header, against ours. Every limiter
 * window is aligned on the SERVER's epoch, so a wait computed on a skewed local
 * clock could start a sequence in a window's last second. One-second resolution;
 * the waits below add a margin for it.
 */
export class ServerClock {
  private skewMs = 0;
  observe(res: Response): void {
    const date = res.headers.get('date');
    if (date) this.skewMs = Date.parse(date) - Date.now();
  }
  now(): number {
    return Date.now() + this.skewMs;
  }
  /** Sleep until a fresh fixed window of `windowMs` has begun, plus a margin. */
  async untilFreshWindow(windowMs: number): Promise<void> {
    await sleep(windowMs - (this.now() % windowMs) + 1_500);
  }
  /** Return at once when `minRemainingMs` of the window is left, else wait for the next. */
  async untilHeadroom(windowMs: number, minRemainingMs: number): Promise<void> {
    if (windowMs - (this.now() % windowMs) >= minRemainingMs + 1_500) return;
    await this.untilFreshWindow(windowMs);
  }
}

export interface CaseContext {
  readonly client: PinnedClient;
  readonly creds: Credentials;
  readonly clock: ServerClock;
}

async function send(ctx: CaseContext, machine: Machine, path: string, init?: RequestInit) {
  const served = await ctx.client.sendTo(machine, path, init);
  ctx.clock.observe(served.response);
  return served;
}

// ── Better-Auth limits (cases 1, 2 and their controls) ──────────────────────

/** Better-Auth's own refusal — told apart from the app guard's (see limits.spec.ts). */
async function expectBetterAuthRefusal(res: Response, windowSeconds: number): Promise<void> {
  check(res.status === 429, `expected 429, got ${res.status}`);
  const retryAfter = Number(res.headers.get('x-retry-after'));
  check(
    retryAfter >= 1 && retryAfter <= windowSeconds,
    `X-Retry-After ${res.headers.get('x-retry-after')} is not in 1..${windowSeconds}`,
  );
  check(
    res.headers.get('x-ratelimit-limit') === null,
    'the refusal carries X-RateLimit-Limit: it came from the app guard, not Better-Auth',
  );
  const body = (await res.json()) as { message?: string; code?: string };
  check(body.code === undefined, `the refusal carries code ${body.code}: not Better-Auth's`);
  check(
    /too many requests/i.test(body.message ?? ''),
    `unexpected refusal body ${JSON.stringify(body)}`,
  );
}

async function sequence(
  ctx: CaseContext,
  machines: readonly Machine[],
  build: () => RequestInit,
  path: string,
  bucket: string,
): Promise<Served[]> {
  const out: Served[] = [];
  for (const machine of machines) {
    const served = await send(ctx, machine, path, build());
    if (out.length === 0 && served.response.status === 429) {
      throw new PreSpentBucketError(
        bucket,
        Number(served.response.headers.get('x-retry-after')) || null,
      );
    }
    out.push(served);
    if (out.length < machines.length) await served.response.arrayBuffer();
  }
  return out;
}

function resetRequest(ctx: CaseContext, email: string) {
  return () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ctx.creds.origin },
    body: JSON.stringify({ email, redirectTo: '/reset-password' }),
  });
}

function wrongSignIn(ctx: CaseContext, email: string) {
  return () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ctx.creds.origin },
    body: JSON.stringify({ email, password: 'not-the-password-1' }),
  });
}

const freshEmail = () => `two-machine-check-${randomUUID()}@example.com`;

/** Case 1 — `/request-password-reset`, 3 per hour: three on A, the 4th on B refused. */
export async function caseResetSplit(ctx: CaseContext): Promise<CaseResult> {
  await ctx.clock.untilHeadroom(3_600_000, 60_000);
  const s = await sequence(
    ctx,
    ['A', 'A', 'A', 'B'],
    resetRequest(ctx, freshEmail()),
    '/api/auth/request-password-reset',
    'password-reset (3 per hour, per runner IP)',
  );
  const statuses = s.map((x) => x.response.status);
  check(!statuses.slice(0, 3).includes(429), `calls 1-3 were ${statuses.slice(0, 3)}`);
  await expectBetterAuthRefusal(s[3]!.response, 3600);
  const pair = attributePair(s[2]!, s[3]!);
  return ok('1', 'password reset: 3 on A, the 4th on B is 429', pair, statuses);
}

/**
 * Case 5 for the reset bucket — the same four calls on ONE machine.
 *
 * ⚠️ It cannot run in the same pass as case 1. The bucket is keyed on the
 * runner's IP for an hour, and behind Fly the runner cannot present another IP
 * (see the header), so a "fresh bucket" for it exists only in the next hour or
 * from another runner. It is the `--reset-control` pass (README).
 */
export async function caseResetControl(ctx: CaseContext): Promise<CaseResult> {
  await ctx.clock.untilHeadroom(3_600_000, 60_000);
  const s = await sequence(
    ctx,
    ['A', 'A', 'A', 'A'],
    resetRequest(ctx, freshEmail()),
    '/api/auth/request-password-reset',
    'password-reset (3 per hour, per runner IP)',
  );
  const statuses = s.map((x) => x.response.status);
  check(!statuses.slice(0, 3).includes(429), `calls 1-3 were ${statuses.slice(0, 3)}`);
  await expectBetterAuthRefusal(s[3]!.response, 3600);
  return control('5-reset', 'control: the same four on A refuse the same 4th call', s, statuses);
}

/** Case 2 — sign-in, 3 per 10 s: A, A, B are 401, the 4th on A is 429. */
export async function caseSignInSplit(ctx: CaseContext): Promise<CaseResult> {
  await ctx.clock.untilFreshWindow(10_000);
  const s = await sequence(
    ctx,
    ['A', 'A', 'B', 'A'],
    wrongSignIn(ctx, freshEmail()),
    '/api/auth/sign-in/email',
    'sign-in (3 per 10 s, per runner IP)',
  );
  const statuses = s.map((x) => x.response.status);
  check(
    statuses.slice(0, 3).every((st) => st === 401),
    `calls 1-3 were ${statuses.slice(0, 3)}, not 401`,
  );
  await expectBetterAuthRefusal(s[3]!.response, 10);
  const pair = attributePair(s[2]!, s[3]!);
  return ok('2', 'sign-in: A, A, B are 401, the 4th on A is 429', pair, statuses);
}

/** Case 5 for sign-in — four on A, in the next window. */
export async function caseSignInControl(ctx: CaseContext): Promise<CaseResult> {
  await ctx.clock.untilFreshWindow(10_000);
  const s = await sequence(
    ctx,
    ['A', 'A', 'A', 'A'],
    wrongSignIn(ctx, freshEmail()),
    '/api/auth/sign-in/email',
    'sign-in (3 per 10 s, per runner IP)',
  );
  const statuses = s.map((x) => x.response.status);
  check(
    statuses.slice(0, 3).every((st) => st === 401),
    `calls 1-3 were ${statuses.slice(0, 3)}, not 401`,
  );
  await expectBetterAuthRefusal(s[3]!.response, 10);
  return control('5-sign-in', 'control: four on A refuse the same 4th call', s, statuses);
}

// ── Budgeted limits (cases 3, 4 and their controls) ─────────────────────────

interface Budget {
  readonly id: string;
  readonly title: string;
  readonly request: () => { path: string; init: RequestInit };
  /** Assert the refusal body; throws CaseFailure. */
  readonly refusal: (res: Response, limit: number) => Promise<void>;
}

function expectRateLimitHeaders(
  res: Response,
  n: number,
): { limit: number; remaining: number; reset: number } {
  const limit = Number(res.headers.get('x-ratelimit-limit'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  check(
    Number.isInteger(limit) && limit > 0 && /^\d+$/.test(remaining ?? '') && reset > 0,
    `call ${n} (${res.status}) carries no rate-limit headers — is the limiter disabled on this ` +
      'deployment (E2E_DISABLE_RATE_LIMIT) or on a per-process store?',
  );
  return { limit, remaining: Number(remaining), reset };
}

/**
 * Spend a budget alternating A and B from the start of a fresh window, then
 * expect the next call refused. `only` pins every call to one machine (the
 * control). The call that spends the last unit must show `remaining: 0`.
 */
async function spendBudget(
  ctx: CaseContext,
  budget: Budget,
  only?: Machine,
): Promise<{
  statuses: number[];
  last: Served;
  refused: Served;
  limit: number;
}> {
  // Read the budget and the window off one probe call, then wait the window out.
  const { path, init } = budget.request();
  const probe = await send(ctx, 'A', path, init);
  const head = expectRateLimitHeaders(probe.response, 0);
  await probe.response.arrayBuffer();
  await sleep(head.reset * 1000 - ctx.clock.now() + 1_500);

  const limit = head.limit;
  const machineFor = (n: number): Machine => only ?? (n % 2 === 1 ? 'A' : 'B');
  const statuses: number[] = [];

  // Calls 1 .. limit-1 in parallel batches: their order does not matter, only
  // that each is served and counted. The last two are sequential.
  const BATCH = 10;
  let firstReset = 0;
  for (let start = 1; start <= limit - 1; start += BATCH) {
    const ns = Array.from({ length: Math.min(BATCH, limit - start) }, (_, i) => start + i);
    const batch = await Promise.all(
      ns.map(async (n) => {
        const r = budget.request();
        const served = await send(ctx, machineFor(n), r.path, r.init);
        const h = expectRateLimitHeaders(served.response, n);
        check(
          served.response.status === 200,
          `call ${n} on ${served.machine} was ${served.response.status}`,
        );
        check(h.limit === limit, `call ${n} reports limit ${h.limit}, the probe ${limit}`);
        await served.response.arrayBuffer();
        return { n, status: served.response.status, reset: h.reset };
      }),
    );
    for (const b of batch) {
      statuses.push(b.status);
      firstReset ||= b.reset;
      check(
        b.reset === firstReset,
        `call ${b.n} counted in another window — the window rolled mid-case`,
      );
    }
  }

  const lastReq = budget.request();
  const last = await send(ctx, machineFor(limit), lastReq.path, lastReq.init);
  const lastHead = expectRateLimitHeaders(last.response, limit);
  check(last.response.status === 200, `call ${limit} (the last unit) was ${last.response.status}`);
  check(lastHead.remaining === 0, `call ${limit} shows remaining ${lastHead.remaining}, not 0`);
  check(
    !firstReset || lastHead.reset === firstReset,
    'the window rolled before the last unit was spent',
  );
  statuses.push(last.response.status);
  await last.response.arrayBuffer();

  const refReq = budget.request();
  const refused = await send(ctx, machineFor(limit + 1), refReq.path, refReq.init);
  expectRateLimitHeaders(refused.response, limit + 1);
  statuses.push(refused.response.status);
  await budget.refusal(refused.response, limit);
  return { statuses, last, refused, limit };
}

const mcpBudget = (ctx: CaseContext): Budget => ({
  id: '3',
  title: 'MCP volume budget',
  request: () => ({
    path: '/api/mcp',
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.creds.pat}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    },
  }),
  async refusal(res, limit) {
    check(res.status === 429, `the call after the budget was ${res.status}, not 429`);
    check(/^\d+$/.test(res.headers.get('retry-after') ?? ''), 'the refusal carries no Retry-After');
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code?: number; data?: { code?: string; limit?: number } };
    };
    check(body.jsonrpc === '2.0', 'the refusal is not a JSON-RPC envelope');
    check(body.error?.code === -32029, `error.code is ${body.error?.code}, not -32029`);
    check(body.error?.data?.code === 'RATE_LIMITED', `data.code is ${body.error?.data?.code}`);
    check(
      body.error?.data?.limit === limit,
      `data.limit is ${body.error?.data?.limit}, not ${limit}`,
    );
  },
});

const v1Budget = (ctx: CaseContext): Budget => ({
  id: '4',
  title: '/api/v1 per-token budget',
  request: () => ({
    path: '/api/v1/me',
    init: { headers: { authorization: `Bearer ${ctx.creds.pat}` } },
  }),
  async refusal(res) {
    check(res.status === 429, `the call after the budget was ${res.status}, not 429`);
    const body = (await res.json()) as { code?: string };
    check(body.code === 'RATE_LIMIT_EXCEEDED', `the refusal code is ${body.code}`);
  },
});

async function budgetSplit(ctx: CaseContext, budget: Budget): Promise<CaseResult> {
  const r = await spendBudget(ctx, budget);
  const pair = attributePair(r.last, r.refused);
  return ok(
    budget.id,
    `${budget.title}: ${r.limit} alternating A/B, the last served with remaining 0, the next 429`,
    pair,
    r.statuses,
  );
}

async function budgetControl(ctx: CaseContext, budget: Budget): Promise<CaseResult> {
  const r = await spendBudget(ctx, budget, 'A');
  return control(
    `5-${budget.id}`,
    `control: ${budget.title}, all on A, refused at the same call (${r.limit + 1})`,
    [r.last, r.refused],
    r.statuses,
  );
}

export const caseMcpSplit = (ctx: CaseContext) => budgetSplit(ctx, mcpBudget(ctx));
export const caseMcpControl = (ctx: CaseContext) => budgetControl(ctx, mcpBudget(ctx));
export const caseV1Split = (ctx: CaseContext) => budgetSplit(ctx, v1Budget(ctx));
export const caseV1Control = (ctx: CaseContext) => budgetControl(ctx, v1Budget(ctx));

// ── Follow-ups (case 6) ─────────────────────────────────────────────────────

/**
 * A follow-up's own calls are not under test as limits, but they spend the same
 * per-runner and per-token buckets the limit cases just emptied. A 429 carrying a
 * `Retry-After` is therefore waited out and the call repeated ONCE; a second 429
 * fails the case. The limit cases above never take this path.
 */
async function paced(ctx: CaseContext, machine: Machine, path: string, init?: () => RequestInit) {
  const first = await send(ctx, machine, path, init?.());
  if (first.response.status !== 429) return first;
  // The window's end, when the refusal names it (`X-RateLimit-Reset`, epoch
  // seconds), is exact; `Retry-After` / Better-Auth's `X-Retry-After` otherwise.
  const h = first.response.headers;
  const reset = Number(h.get('x-ratelimit-reset'));
  const retryAfter = Number(h.get('retry-after') ?? h.get('x-retry-after'));
  const waitMs =
    reset > 0
      ? reset * 1000 - ctx.clock.now()
      : (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10) * 1000;
  await first.response.arrayBuffer();
  await sleep(waitMs + 1_500);
  return send(ctx, machine, path, init?.());
}

let rpcId = 0;

async function mcp(
  ctx: CaseContext,
  machine: Machine,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ served: Served; result?: Record<string, unknown>; error?: unknown }> {
  const served = await paced(ctx, machine, '/api/mcp', () => {
    rpcId += 1;
    return {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.creds.pat}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
    };
  });
  const text = await served.response.text();
  const json = (served.response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
    : text;
  let body: { result?: Record<string, unknown>; error?: unknown };
  try {
    body = JSON.parse(json) as typeof body;
  } catch {
    throw new CaseFailure(
      `${method} on ${machine} answered ${served.response.status}: ${text.slice(0, 300)}`,
    );
  }
  return { served, ...body };
}

function toolText(result: Record<string, unknown> | undefined): string {
  const content = (result?.['content'] ?? []) as Array<{ text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

async function tool(
  ctx: CaseContext,
  machine: Machine,
  name: string,
  args: Record<string, unknown>,
) {
  const r = await mcp(ctx, machine, 'tools/call', { name, arguments: args });
  check(
    r.served.response.status === 200,
    `${name} on ${machine} answered ${r.served.response.status}`,
  );
  check(
    r.result?.['isError'] !== true,
    `${name} on ${machine} failed: ${toolText(r.result).slice(0, 400)}`,
  );
  const structured = (r.result?.['structuredContent'] ?? null) as Record<string, unknown> | null;
  return { served: r.served, text: toolText(r.result), structured };
}

export interface Session {
  readonly cookie: string;
  readonly user: { id: string; email: string; name: string };
  readonly signedInOn: Served;
  readonly workspaceId: string;
}

/**
 * Sign the test user in ONCE, on A, in a fresh sign-in window (the bucket is the
 * runner's, and the sign-in cases just spent it), and read the token's workspace.
 */
export async function signInOnce(ctx: CaseContext): Promise<Session> {
  await ctx.clock.untilFreshWindow(10_000);
  const signedInOn = await send(ctx, 'A', '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ctx.creds.origin },
    body: JSON.stringify({ email: ctx.creds.email, password: ctx.creds.password }),
  });
  await expectStatus(signedInOn, 200, "the test user's sign-in on A");
  const cookie = signedInOn.response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  check(cookie.includes('session_token'), 'the sign-in set no session cookie');
  const body = (await signedInOn.response.json()) as {
    user?: { id: string; email: string; name: string };
  };
  check(body.user?.id, 'the sign-in answered no user');

  const me = await paced(ctx, 'A', '/api/v1/me', () => ({
    headers: { authorization: `Bearer ${ctx.creds.pat}` },
  }));
  check(me.response.status === 200, `/api/v1/me with the test PAT answered ${me.response.status}`);
  const meBody = (await me.response.json()) as { user: { id: string }; workspaceId: string };
  check(
    meBody.user.id === body.user.id,
    'STAGING_PAT belongs to a different user than STAGING_USER_EMAIL — both must be the test account',
  );
  return { cookie, user: body.user, signedInOn, workspaceId: meBody.workspaceId };
}

/** (a) the session issued on A loads an authed page on B, with the user's own name on it. */
export async function caseSession(ctx: CaseContext, session: Session): Promise<CaseResult> {
  const onA = await send(ctx, 'A', '/api/auth/get-session', {
    headers: { cookie: session.cookie, origin: ctx.creds.origin },
  });
  const who = (await onA.response.json()) as { user?: { email?: string } } | null;
  check(who?.user?.email === session.user.email, 'get-session on A does not name the test user');

  let page = await send(ctx, 'B', '/workbench', { headers: { cookie: session.cookie } });
  for (
    let hop = 0;
    hop < 3 && page.response.status >= 300 && page.response.status < 400;
    hop += 1
  ) {
    const location = new URL(page.response.headers.get('location') ?? '', ctx.client.origin);
    check(!/sign-in/.test(location.pathname), `B redirected the session to ${location.pathname}`);
    page = await send(ctx, 'B', location.pathname + location.search, {
      headers: { cookie: session.cookie },
    });
  }
  check(page.response.status === 200, `the authed page on B answered ${page.response.status}`);
  check(
    (await page.response.text()).includes(session.user.name),
    'the page on B does not show the user',
  );
  return ok('6a', 'session from A loads an authed page on B', attributePair(onA, page), [
    onA.response.status,
    page.response.status,
  ]);
}

/** (b) MCP initialize on A, then tools/list and a write on B; the item reads back on both. */
export async function caseMcpSession(ctx: CaseContext): Promise<CaseResult> {
  const init = await mcp(ctx, 'A', 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'two-machine-check', version: '1.0.0' },
  });
  check(
    init.served.response.status === 200,
    `initialize on A answered ${init.served.response.status}`,
  );
  check(init.result?.['serverInfo'], 'initialize answered no serverInfo');

  const list = await mcp(ctx, 'B', 'tools/list');
  check(
    list.served.response.status === 200,
    `tools/list on B answered ${list.served.response.status}`,
  );
  const names = ((list.result?.['tools'] ?? []) as Array<{ name: string }>).map((t) => t.name);
  check(names.includes('create_work_item'), 'tools/list on B does not offer create_work_item');

  const title = `two-machine-check mcp write ${randomUUID()}`;
  const created = await tool(ctx, 'B', 'create_work_item', {
    projectKey: ctx.creds.projectKey,
    kind: 'task',
    title,
  });
  const key = created.text.match(new RegExp(`${ctx.creds.projectKey}-\\d+`))?.[0];
  check(key, `create_work_item on B named no key: ${created.text.slice(0, 300)}`);
  for (const machine of ['A', 'B'] as const) {
    const read = await tool(ctx, machine, 'get_work_item', { key });
    check(read.text.includes(title), `get_work_item on ${machine} does not show the write`);
  }
  return ok(
    '6b',
    'MCP initialize on A; tools/list and a write on B; read on both',
    attributePair(init.served, list.served),
    [init.served.response.status, list.served.response.status, created.served.response.status],
  );
}

/** (c1) the same idempotency key on A then B opens ONE dispatch run. */
export async function caseIdempotentWrite(ctx: CaseContext): Promise<CaseResult> {
  const idempotencyKey = `two-machine-check-${randomUUID()}`;
  const open = (machine: Machine) =>
    paced(ctx, machine, '/api/v1/dispatch-runs', () => ({
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.creds.pat}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectKey: ctx.creds.projectKey, command: 'next', idempotencyKey }),
    }));
  const first = await open('A');
  const second = await open('B');
  const statuses = [first.response.status, second.response.status];
  check(
    statuses.every((s) => s === 201),
    `the two opens answered ${statuses}`,
  );
  const one = (await first.response.json()) as { run: { id: string }; created: boolean };
  const two = (await second.response.json()) as { run: { id: string }; created: boolean };
  check(one.created === true, 'the first open did not create a run');
  check(two.created === false, 'the repeat on B created a second run');
  check(two.run.id === one.run.id, 'the repeat on B answered a different run');
  return ok(
    '6c1',
    'a repeated idempotent write, A then B, applied once',
    attributePair(first, second),
    statuses,
  );
}

/** A planned plan with one `add` proposal titled `title`, seeded over MCP. */
async function seedPlannedPlan(ctx: CaseContext, title: string): Promise<string> {
  const created = await tool(ctx, 'A', 'create_plan', {
    projectKey: ctx.creds.projectKey,
    title: 'two-machine-check plan',
  });
  // The tool answers prose: "Opened plan <id> on <KEY> — …".
  const planId = /\bOpened plan (\S+)/.exec(created.text)?.[1];
  check(planId, `create_plan named no plan id: ${created.text.slice(0, 300)}`);
  await tool(ctx, 'A', 'add_plan_items', {
    planId,
    proposals: [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    final: true,
  });
  return planId;
}

/** How many work items in the test project carry exactly `title`, read over MCP on `machine`. */
async function countItemsTitled(
  ctx: CaseContext,
  machine: Machine,
  title: string,
): Promise<number> {
  const found = await tool(ctx, machine, 'search_work_items', {
    projectKey: ctx.creds.projectKey,
    filter: {
      version: 'v1',
      combinator: 'and',
      conditions: [{ field: 'text', operator: 'contains', value: title }],
    },
  });
  // `structuredContent.items` carries the matched rows; the `text` filter is a
  // substring match, so the count is of rows whose title is EXACTLY `title`.
  const items = (found.structured?.['items'] ?? null) as Array<{ title?: string }> | null;
  check(Array.isArray(items), `search_work_items on ${machine} returned no structured items`);
  return items.filter((i) => i.title === title).length;
}

async function stampOf(ctx: CaseContext, machine: Machine, session: Session, planId: string) {
  const res = await send(ctx, machine, `/api/plans/${planId}`, {
    headers: { cookie: session.cookie },
  });
  check(
    res.response.status === 200,
    `the plan review on ${machine} answered ${res.response.status}`,
  );
  const review = (await res.response.json()) as { gate?: { stamp?: string | null } | null };
  check(review.gate?.stamp, `plan ${planId} has no awaiting gate stamp`);
  return review.gate.stamp;
}

const approve = (
  ctx: CaseContext,
  machine: Machine,
  session: Session,
  planId: string,
  stamp: string,
) =>
  send(ctx, machine, `/api/plans/${planId}/approve`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      origin: ctx.creds.origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ stamp }),
  });

/** (c2) a plan approved on A and again on B — then on both at once — materializes once. */
export async function casePlanApprove(ctx: CaseContext, session: Session): Promise<CaseResult> {
  const seqTitle = `two-machine-check proposal ${randomUUID()}`;
  const seqPlan = await seedPlannedPlan(ctx, seqTitle);
  const stamp = await stampOf(ctx, 'A', session, seqPlan);
  const first = await approve(ctx, 'A', session, seqPlan, stamp);
  await expectStatus(first, 200, 'approve on A');
  const second = await approve(ctx, 'B', session, seqPlan, stamp);
  check(second.response.status < 500, `the repeat approve on B answered ${second.response.status}`);
  check(
    (await countItemsTitled(ctx, 'B', seqTitle)) === 1,
    'the sequential double approve did not materialize exactly once',
  );

  const raceTitle = `two-machine-check proposal ${randomUUID()}`;
  const racePlan = await seedPlannedPlan(ctx, raceTitle);
  const raceStamp = await stampOf(ctx, 'B', session, racePlan);
  const [onA, onB] = await Promise.all([
    approve(ctx, 'A', session, racePlan, raceStamp),
    approve(ctx, 'B', session, racePlan, raceStamp),
  ]);
  const raced = [onA.response.status, onB.response.status];
  check(raced.includes(200), `neither concurrent approve succeeded: ${raced}`);
  check(
    raced.every((s) => s < 500),
    `a concurrent approve answered ${raced}`,
  );
  check(
    (await countItemsTitled(ctx, 'A', raceTitle)) === 1,
    'the concurrent double approve did not materialize exactly once',
  );
  attributePair(onA, onB);
  return ok(
    '6c2',
    'a double plan approve, A then B and A with B, applied once',
    attributePair(first, second),
    [first.response.status, second.response.status, ...raced],
  );
}

/** (d) a device grant started on A, approved on B, redeemed on A; the token works on B. */
export async function caseDeviceFlow(ctx: CaseContext, session: Session): Promise<CaseResult> {
  const started = await send(ctx, 'A', '/api/cli/device/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'two-machine-check' }),
  });
  check(started.response.status === 200, `device start on A answered ${started.response.status}`);
  const grant = (await started.response.json()) as { device_code: string; user_code: string };

  const described = await send(
    ctx,
    'B',
    `/api/cli/device/grant?user_code=${encodeURIComponent(grant.user_code)}`,
    {
      headers: { cookie: session.cookie, origin: ctx.creds.origin },
    },
  );
  check(described.response.status === 200, `the grant on B answered ${described.response.status}`);
  const approved = await send(ctx, 'B', '/api/cli/device/approve', {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      origin: ctx.creds.origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ userCode: grant.user_code, workspaceId: session.workspaceId }),
  });
  check(approved.response.status < 300, `approve on B answered ${approved.response.status}`);

  const polled = await send(ctx, 'A', '/api/cli/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.device_code,
      client_id: CLI_CLIENT_ID,
    }),
  });
  check(polled.response.status === 200, `the token poll on A answered ${polled.response.status}`);
  const issued = (await polled.response.json()) as { access_token: string; user: { id: string } };
  check(issued.user.id === session.user.id, 'the token was issued to another user');

  const me = await paced(ctx, 'B', '/api/v1/me', () => ({
    headers: { authorization: `Bearer ${issued.access_token}` },
  }));
  check(me.response.status === 200, `the issued token on B answered ${me.response.status}`);
  attributePair(polled, me);
  return ok(
    '6d',
    'device grant started on A, approved on B, redeemed on A',
    attributePair(started, described),
    [
      started.response.status,
      described.response.status,
      approved.response.status,
      polled.response.status,
      me.response.status,
    ],
  );
}

/** (e) a write on B reaches a workbench stream held on A within the coalescing window plus a margin. */
export async function caseStream(ctx: CaseContext, session: Session): Promise<CaseResult> {
  const stream = await send(ctx, 'A', '/api/workbench/stream', {
    headers: { cookie: session.cookie },
  });
  check(stream.response.status === 200, `the stream on A answered ${stream.response.status}`);
  const reader = stream.response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (deadlineMs: number): Promise<{ event: string; data: unknown } | null> => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (raw.startsWith(':')) continue;
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        return { event, data: data === undefined ? null : JSON.parse(data) };
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const chunk = await Promise.race([reader.read(), sleep(left).then(() => null)]);
      if (chunk === null || chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    const opening = await next(5_000);
    check(opening?.event === WORKBENCH_STREAM_FRAME, 'the stream on A sent no opening frame');
    const created = await tool(ctx, 'B', 'create_work_item', {
      projectKey: ctx.creds.projectKey,
      kind: 'task',
      title: `two-machine-check stream ${randomUUID()}`,
    });
    const MARGIN_MS = 3_000;
    const frame = await next(WORKBENCH_STREAM_COALESCE_MS + MARGIN_MS);
    check(
      frame?.event === WORKBENCH_STREAM_FRAME,
      `no ${WORKBENCH_STREAM_FRAME} frame within the coalescing window plus margin`,
    );
    check(
      ((frame?.data as { moved?: string[] } | null)?.moved ?? []).length > 0,
      'the frame moved nothing',
    );
    return ok(
      '6e',
      'a write on B reaches a workbench stream held on A',
      attributePair(stream, created.served),
      [stream.response.status, created.served.response.status],
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ── results ─────────────────────────────────────────────────────────────────

function ok(
  id: string,
  title: string,
  pair: { first: string; second: string },
  statuses: number[],
): CaseResult {
  return { id, title, pass: true, first: pair.first, second: pair.second, statuses, detail: '' };
}

/** A control's two requests are on ONE machine by design; each must still be attributed. */
function control(
  id: string,
  title: string,
  served: readonly Served[],
  statuses: number[],
): CaseResult {
  const ids = served.map((s) => s.machineId);
  check(ids.every(Boolean), `cannot attribute the response to a machine (control ${id})`);
  return {
    id,
    title,
    pass: true,
    first: ids[0]!,
    second: ids[ids.length - 1]!,
    statuses,
    detail: '',
  };
}
