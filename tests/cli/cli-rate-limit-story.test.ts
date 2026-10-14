import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import {
  startMcpHttpServer,
  type McpTestServer,
  type RecordedRequest,
} from '../helpers/mcpHttpServer';
import {
  installFakeGh,
  makeCliWorkspace,
  writeFakeAgent,
  type CliWorkspace,
  type FakeAgent,
} from '../helpers/cliHarness';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { waitForWindowBoundary } from '../helpers/rateLimitWindow';

// A THROTTLED `motir run`, END TO END (MOTIR-8608 · Story MOTIR-8548 criterion 9,
// verification step 6 read against a local app).
//
// The CLI's retry was proved against a STUB server (`packages/cli/test/
// transport.test.ts`, MOTIR-8602). This suite runs the BUILT bundle as a child
// process against the REAL `/api/v1` routes over a real socket and real
// Postgres, and watches a real loop be refused, wait, and carry on. Three things
// only this tier can see: whether the bundle carries the retry, whether the
// real `withV1Route` refuses BEFORE the claim handler writes (which is what
// makes re-sending a refused claim safe), and whether a loop CONTINUES past a
// refusal rather than one call merely returning.
//
// ⚠️ The budget shrunk is `/api/v1`'s per-token limb, not `mcp:call`'s: the
// CLI is a v1 client and never reaches `/api/mcp`. `withV1Route` reads the
// budget per request in THIS process, which is where the routes run, so
// `vi.stubEnv` here throttles the harness without the child knowing.
//
// The workspace ceiling is pinned far above anything a run spends, so the only
// limb that can refuse is the per-token one.
//
// The budgets are MEASURED, never typed: each case first runs the same command
// unthrottled against an identical fixture and counts its requests from the
// server's request log. As measured on 2026-10-14 by this file's own
// unthrottled runs: a `motir run <key> --agent` makes L = 3 requests before its
// claim (`GET /work-items/{key}`, `GET /me`, `GET /workspaces`), and a
// three-card `motir auto` drain makes N = 33 in total, so case 2 runs at 11 per
// window. The test uses what it measures on every run, so a change to the CLI's
// request pattern moves the budget with it rather than breaking the case.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/** The throttled window: small enough that a wait costs at most ~5 s. */
const WINDOW_MS = 5_000;

let server: McpTestServer;
let ws: CliWorkspace;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true, recordRequests: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  ws = makeCliWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitStore();
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface Linked {
  fx: WorkItemFixture;
  agent: FakeAgent;
}

/** A tenant with a full-scope PAT, logged in and linked, with a fake `gh` and a
 *  scripted agent — all BEFORE any budget is stubbed. */
async function linked(): Promise<Linked> {
  const fx = await makeWorkItemFixture();
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'cli',
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  expect((await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode).toBe(
    0,
  );
  expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);
  installFakeGh(ws.binDir);
  return { fx, agent: writeFakeAgent(join(ws.root, '.agent')) };
}

async function task(fx: WorkItemFixture, title: string): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, type: 'code' },
    fx.ctx,
  );
}

/** The `/api/v1` requests answered since `from` (a log length), in ARRIVAL order. */
function v1Since(from: number): RecordedRequest[] {
  return server
    .requestLog()
    .slice(from)
    .filter((r) => r.path.startsWith('/api/v1/'))
    .sort((a, b) => a.startedAt - b.startedAt);
}

const isClaim = (r: RecordedRequest) =>
  r.method === 'POST' && /^\/api\/v1\/work-items\/[^/]+\/claim$/.test(r.path);

const claimsOf = (requests: RecordedRequest[], key: string) =>
  requests.filter((r) => isClaim(r) && r.path === `/api/v1/work-items/${key}/claim`);

/** Shrink the per-token v1 budget to `limit` per 5 s window, pin the ceiling out
 *  of reach, and hand the run a whole fresh window. */
async function throttle(limit: number): Promise<void> {
  vi.stubEnv('MOTIR_API_V1_RATE_LIMIT', String(limit));
  vi.stubEnv('MOTIR_API_V1_RATE_LIMIT_WINDOW_MS', String(WINDOW_MS));
  vi.stubEnv('MOTIR_AGENT_WORKSPACE_RATE_LIMIT', '100000');
  await waitForWindowBoundary(WINDOW_MS);
  resetRateLimitStore();
}

/**
 * How many times the card was CLAIMED, read from the server's own records
 * rather than from the CLI's output: the status revisions that moved it into
 * `in_progress`, and the dispatch-run legs that name it.
 */
async function claimRecord(item: WorkItemDto): Promise<{ intoInProgress: number; legs: number }> {
  const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId: item.id } });
  const intoInProgress = revisions.filter((r) => {
    const diff = r.diff as { status?: { to?: unknown } } | null;
    return diff?.status?.to === 'in_progress';
  }).length;
  const legs = await adminDb.dispatchRunCard.count({ where: { workItemId: item.id } });
  return { intoInProgress, legs };
}

const WAIT_LINE = /Rate limited by \S+; waiting (\d+)s before retrying/g;

// ── cases ───────────────────────────────────────────────────────────────────

describe('a throttled `motir run` is refused, waits, carries on, and claims nothing twice', () => {
  it('case 1 — a refused CLAIM is waited out and re-sent, and the card is claimed once', async () => {
    const { fx, agent } = await linked();
    const probe = await task(fx, 'The unthrottled twin');
    const item = await task(fx, 'Claimed through a refusal');

    // MEASURE L: the requests an unthrottled run makes before its claim.
    const before = server.requestLog().length;
    const free = await ws.run(['run', probe.identifier, '--agent', agent.command]);
    expect(free.exitCode, free.output).toBe(0);
    const freeRequests = v1Since(before);
    const L = freeRequests.findIndex(isClaim);
    expect(L, 'the unthrottled run made no claim').toBeGreaterThan(0);

    // THROTTLE to exactly L: every pre-claim request fits, the claim does not.
    await throttle(L);
    const from = server.requestLog().length;
    const ran = await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(ran.exitCode, ran.output).toBe(0);

    const requests = v1Since(from);
    expect(requests.slice(0, L).every((r) => r.status === 200)).toBe(true);
    const claims = claimsOf(requests, item.identifier);
    expect(claims.map((r) => r.status)).toEqual([429, 200]);
    // The re-send came back no sooner than the refusal said.
    const [refused, accepted] = claims as [RecordedRequest, RecordedRequest];
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(accepted.startedAt - refused.at).toBeGreaterThanOrEqual(
      Number(refused.retryAfter) * 1000 - 25,
    );

    expect(ran.stderr).toMatch(/Rate limited by \S+; waiting \d+s before retrying/);
    expect(agent.invocations()).toHaveLength(2); // the probe's, and this one
    expect(agent.invocations()[1]?.stdin).toContain(item.identifier);

    // ONE claim: the refusal wrote nothing, so the re-send is the only writer.
    expect(await claimRecord(item)).toEqual({ intoInProgress: 1, legs: 1 });
    expect((await workItemsService.getWorkItem(item.id, fx.ctx)).status).not.toBe('todo');
  });

  it('case 2 — a three-card loop is refused more than once, waits each time, and finishes', async () => {
    // `auto` drains the whole ready set, so the measured cards are created and
    // drained BEFORE the throttled cards exist: each drain sees only its own three.
    const { fx, agent } = await linked();
    const titles = ['First of three', 'Second of three', 'Third of three'];

    // MEASURE N on an identical drain.
    for (const title of titles) await task(fx, `${title} (unthrottled)`);
    const before = server.requestLog().length;
    const free = await ws.run(['auto', '--agent', agent.command]);
    expect(free.exitCode, free.output).toBe(0);
    expect(agent.invocations()).toHaveLength(3);
    const freeRequests = v1Since(before);
    const N = freeRequests.length;
    expect(N).toBeGreaterThan(6);

    const items: WorkItemDto[] = [];
    for (const title of titles) items.push(await task(fx, title));
    await throttle(Math.max(2, Math.floor(N / 3)));
    const from = server.requestLog().length;
    const ran = await ws.run(['auto', '--agent', agent.command]);
    expect(ran.exitCode, ran.output).toBe(0);

    const requests = v1Since(from);
    const refusals = requests.filter((r) => r.status === 429);
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    for (const r of refusals) expect(Number(r.retryAfter)).toBeGreaterThanOrEqual(1);
    expect([...ran.stderr.matchAll(WAIT_LINE)]).toHaveLength(refusals.length);
    // Every other answer is one the unthrottled drain also got: the throttle
    // added refusals and nothing else.
    const freeStatuses = new Set(freeRequests.map((r) => r.status));
    expect(requests.filter((r) => r.status !== 429 && !freeStatuses.has(r.status))).toEqual([]);

    // No request after a refusal was sent sooner than that refusal's Retry-After.
    for (const r of refusals) {
      const next = requests.find((n) => n.startedAt > r.startedAt && n !== r);
      expect(next, `nothing followed the 429 on ${r.path}`).toBeDefined();
      expect(next!.startedAt - r.at).toBeGreaterThanOrEqual(Number(r.retryAfter) * 1000 - 25);
    }

    // Three invocations, on three distinct keys — each card once.
    const invoked = agent.invocations().slice(3);
    expect(invoked).toHaveLength(3);
    const keys = invoked.map((inv) => items.find((i) => inv.stdin.includes(i.identifier))?.key);
    expect(new Set(keys).size).toBe(3);
    // ⚠️ The claim is read from the status trail and the claim requests, not
    // from dispatch-run legs: `motir auto` records NO legs at all today, throttled
    // or not — its idempotent re-open is answered without the new card
    // (MOTIR-8632). Case 1's `motir run` opens with its card and carries the leg.
    for (const item of items) {
      expect(claimsOf(requests, item.identifier).filter((r) => r.status === 200)).toHaveLength(1);
      expect((await claimRecord(item)).intoInProgress).toBe(1);
    }
  });

  it('case 3 — a claim the server REFUSES (not a 429) is sent once and never waited on', async () => {
    const { fx, agent } = await linked();
    const item = await task(fx, 'Somebody else holds this');

    // Another member claims it first, through the service — the real refusal.
    const rival = await usersService.createUser({
      email: `rival+${randomToken()}@example.com`,
      password: 'hunter2hunter2',
      name: 'Rival Runner',
    });
    await workspacesService.addMember({ userId: rival.id, workspaceId: fx.workspaceId });
    const taken = await workItemsService.claimWorkItem(fx.projectId, item.identifier, {
      userId: rival.id,
      workspaceId: fx.workspaceId,
    });
    expect(taken.outcome).toBe('claimed');

    const from = server.requestLog().length;
    const ran = await ws.run(['run', item.identifier, '--agent', agent.command, '--force']);

    const claims = claimsOf(v1Since(from), item.identifier);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).not.toBe(429);
    expect(ran.stderr).not.toMatch(/Rate limited by/);
    expect(ran.stderr).toContain(`${item.identifier}: already claimed`);
    expect(agent.invocations()).toHaveLength(0);
  });
});
