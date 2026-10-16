import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// THE STORY TEST GATE, SEAM 1 (Story MOTIR-8538 · MOTIR-8681): seed → manifest →
// server, over a real Postgres. The REAL seed writes a REAL manifest; its tokens go
// through `app/api/mcp/route.ts` (`withMcpAuth` + `verifyMcpToken`) in exactly the
// wire shape `loadtest/k6/lib/mcpClient.js` sends, with the arguments the agent
// scenarios' own `pickAgent` / `pickArgs` choose, and every answer is judged by the
// scenarios' own `classifyMcpResponse`. Its cookies go through the workbench window
// and plan read handlers. Nothing between the seed and the classifier is retyped.
//
// The run lifecycle's iteration over the same seed is
// `tests/loadtest/runLifecycle.test.ts` › "one run iteration against the shipped
// routes" (it seeds with `seedTenants`, the seed's own body).
//
// `next/headers` answers the request's own headers, exactly as
// `tests/loadtest/seed.test.ts` argues for it: it stands in for the Next.js request
// scope and is not under test.

vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => {
  const jar = () =>
    new Map(
      (request.headers.get('cookie') ?? '')
        .split(/;\s*/)
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf('=');
          return [c.slice(0, i), c.slice(i + 1)] as [string, string];
        }),
    );
  return {
    headers: async () => request.headers,
    cookies: async () => ({
      get: (name: string) => {
        const value = jar().get(name);
        return value === undefined ? undefined : { name, value };
      },
      getAll: () => [...jar()].map(([name, value]) => ({ name, value })),
      has: (name: string) => jar().has(name),
      set: () => {},
    }),
  };
});

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { mcpRouteFetch } = await import('../helpers/mcpRouteFetch');
const { settleServerWork } = await import('../helpers/serverWork');
const windowRoute = await import('@/app/api/workbench/window/route');
const planRoute = await import('@/app/api/plans/[id]/route');

const { runSeed } = await import('@/loadtest/seed/seed');
const { runReset } = await import('@/loadtest/seed/reset');
const { readManifest } = await import('@/loadtest/seed/manifest');
const { endpointHost } = await import('@/loadtest/lib/endpointHost');
const { pickAgent, pickArgs } = await import('@/loadtest/k6/lib/agents.js');
const { classifyMcpResponse, parseRpcBody } = await import('@/loadtest/k6/lib/classify.js');
const { windowPath } = await import('@/loadtest/k6/lib/windowReadGate.js');

type Manifest = Awaited<ReturnType<typeof readManifest>>;
type Agent = Manifest['agents'][number];

const BASE = 'http://localhost:3000';
const TAG = 'gate';
const PROD_HOST = 'ep-prod-1.eu-central-1.aws.neon.tech';

function seedEnv(over: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: process.env['DATABASE_URL'],
    DATABASE_URL_UNPOOLED: process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL'],
    BETTER_AUTH_SECRET: process.env['BETTER_AUTH_SECRET'],
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
    MOTIR_BASE_URL: BASE,
    NODE_ENV: 'production',
    LOADTEST_ALLOWED_DB_HOST: endpointHost(process.env['DATABASE_URL']) ?? 'localhost',
    LOADTEST_PRODUCTION_DB_HOSTS: PROD_HOST,
    ...over,
  };
}

/** The agent mix: each role's tools, from the smoke profile the seed shape belongs to. */
async function agentMix(): Promise<[string, string[]][]> {
  const smoke = JSON.parse(await readFile('loadtest/profiles/smoke.json', 'utf8')) as {
    toolWeights: Record<'read' | 'write', Record<string, number>>;
  };
  return [
    ['read', Object.keys(smoke.toolWeights.read)],
    ['write', Object.keys(smoke.toolWeights.write)],
    ['claim', ['claim_work_item']],
    ['burst', ['move_to_parent']],
  ];
}

let rpcId = 0;
/** One `tools/call`, in the wire shape `loadtest/k6/lib/mcpClient.js` sends. */
async function callTool(token: string, tool: string, args: unknown) {
  rpcId += 1;
  const res = await mcpRouteFetch(token)(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const body = await res.text();
  return { body, ...classifyMcpResponse({ status: res.status, headers: res.headers, body, tool }) };
}

/** Two agents of `role`, in two different workspaces, as VUs 0, 1, … would get them. */
function twoAgents(m: Manifest, role: string): Agent[] {
  const out: Agent[] = [];
  for (let vu = 0; out.length < 2 && vu < m.agents.length; vu += 1) {
    const { agent } = pickAgent(m, role, vu) as { agent: Agent };
    if (!out.some((a) => a.workspaceId === agent.workspaceId)) out.push(agent);
  }
  expect(out, `two ${role} agents in two workspaces`).toHaveLength(2);
  return out;
}

/** Every role × agent × tool once; returns `role/tool/workspace → outcome`. */
async function mixPass(m: Manifest, n: number): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  for (const [role, tools] of await agentMix()) {
    for (const [i, agent] of twoAgents(m, role).entries()) {
      for (const tool of tools) {
        const r = await callTool(agent.token, tool, pickArgs(m, agent, tool, n));
        const empty =
          tool === 'claim_work_item' &&
          ['taken', 'not_claimable'].includes(String(r.structured?.['outcome']));
        expect(
          r.outcome === 'ok' || (r.outcome === 'empty' && empty),
          `${role} ${tool}: ${r.outcome} ${r.body.slice(0, 300)}`,
        ).toBe(true);
        seen.set(`${role}/${tool}/${i}`, r.outcome);
      }
    }
  }
  return seen;
}

let dir: string;
let manifestPath: string;
let manifest: Manifest;

beforeAll(async () => {
  await truncateAuthTables();
  dir = await mkdtemp(join(tmpdir(), 'story-gate-seed-'));
  manifestPath = join(dir, 'manifest.json');
  expect(await runSeed(['--tag', TAG, '--out', manifestPath], seedEnv(), () => {})).toBe(0);
  manifest = await readManifest(manifestPath);
}, 300_000);

afterAll(async () => {
  await settleServerWork();
  await rm(dir, { recursive: true, force: true });
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

type PoolRow = { id: string; status: string; assigneeId: string | null; parentId: string | null };
async function poolState(m: Manifest): Promise<PoolRow[]> {
  const ids = m.projects.flatMap((p) => [...p.pools.claim, ...p.pools.write].map((c) => c.id));
  return adminDb.workItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, assigneeId: true, parentId: true },
    orderBy: { id: 'asc' },
  });
}

describe('seam 1 — the manifest’s tokens, through the MCP route, judged by the scenario classifier', () => {
  let seeded: PoolRow[];
  let first: Map<string, string>;

  it('every tool of the mix classifies ok, or empty only for a claim the pool no longer holds', async () => {
    seeded = await poolState(manifest);
    first = await mixPass(manifest, 0);
    // The second claim agent reaches for its own share — a claim on a card that is
    // already held answers `taken`, which is the one sanctioned `empty`.
    const claimer = twoAgents(manifest, 'claim')[0]!;
    const again = await callTool(
      claimer.token,
      'claim_work_item',
      pickArgs(manifest, claimer, 'claim_work_item', 0),
    );
    expect(['ok', 'empty']).toContain(again.outcome);
  }, 300_000);

  // The card expected a JSON-RPC `error` member. The shipped SDK answers the
  // strict-input refusal as a TOOL RESULT with `isError` whose text carries the
  // -32602 and names the key (read 2026-10-15) — the classifier's `isError` rule
  // makes it `error` either way, which is what this case pins.
  it('an argument key the tool does not know is refused at HTTP 200, classified error', async () => {
    const reader = twoAgents(manifest, 'read')[0]!;
    const args = { ...pickArgs(manifest, reader, 'get_work_item', 0), notAField: true };
    const r = await callTool(reader.token, 'get_work_item', args);
    const rpc = parseRpcBody(r.body) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(rpc.result?.isError).toBe(true);
    expect(rpc.result?.content?.[0]?.text).toMatch(/-32602.*notAField/);
    expect(r.outcome).toBe('error');
  });

  it('RLS across the seam: a read agent’s get_work_item on the other workspace never returns the card', async () => {
    const reader = twoAgents(manifest, 'read')[0]!;
    const foreign = manifest.projects.find((p) => p.workspaceId !== reader.workspaceId)!;
    const card = foreign.content.subtasks[0]!;
    const r = await callTool(reader.token, 'get_work_item', { key: card.key });
    expect(r.outcome).toBe('error');
    expect(r.body).not.toContain(card.id);
  });

  it('a reset puts every pool card back, and a second pass classifies the same way', async () => {
    expect(await runReset(['--manifest', manifestPath], seedEnv(), () => {})).toBe(0);
    manifest = await readManifest(manifestPath);
    expect(await poolState(manifest)).toEqual(seeded);
    const second = await mixPass(manifest, 0);
    expect(second).toEqual(first);
  }, 300_000);
});

describe('seam 1 — the manifest’s cookies, read by the handlers', () => {
  const withCookie = async <T>(cookie: string, f: () => Promise<T>) => {
    request.headers = new Headers({ cookie });
    try {
      return await f();
    } finally {
      request.headers = new Headers();
    }
  };

  it('a reader’s cookie gets 200 from the workbench window and from a plan read', async () => {
    const user = manifest.users[0]!;
    const plan = manifest.projects.find((p) => p.workspaceId === user.readerWorkspaceId)!
      .readPlanIds[0]!;
    const win = await withCookie(user.cookieHeader, () =>
      windowRoute.GET(
        new Request(`${BASE}${windowPath('todo')}`, { headers: { cookie: user.cookieHeader } }),
      ),
    );
    expect(win.status, await win.clone().text()).toBe(200);
    const read = await withCookie(user.cookieHeader, () =>
      planRoute.GET(
        new Request(`${BASE}/api/plans/${plan}`, {
          headers: { cookie: user.cookieHeader },
        }) as never,
        {
          params: Promise.resolve({ id: plan }),
        },
      ),
    );
    expect(read.status, await read.clone().text()).toBe(200);
  });

  // lib/auth reads NODE_ENV, MOTIR_BASE_URL and the harness flag at IMPORT time, so
  // each environment gets a fresh module graph.
  for (const base of ['http://motir-core-staging.flycast', 'https://staging.example.test'])
    it(`the seed’s cookie name and attributes are Better-Auth’s own for ${base.split(':')[0]}://`, async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('MOTIR_BASE_URL', base);
      vi.stubEnv('E2E_PROD_HARNESS', '');
      vi.resetModules();
      try {
        const fresh = await import('@/lib/auth');
        const { mintSessionCookie } = await import('@/loadtest/seed/tenants');
        const { shouldUseSecureCookies } = await import('@/lib/e2eProdHarness');
        const freshDb = (await import('@/lib/db')).db;
        const ctx = await fresh.auth.$context;
        const minted = await mintSessionCookie(manifest.users[0]!.id);
        expect(minted.cookieName).toBe(ctx.authCookies.sessionToken.name);
        expect(minted.cookieName.startsWith('__Secure-')).toBe(base.startsWith('https://'));
        expect(shouldUseSecureCookies()).toBe(true);
        expect(ctx.authCookies.sessionToken.attributes.secure).toBe(true);
        await freshDb.$disconnect();
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

  it('the manifest the seed wrote names the cookie the same way for its own (http) base URL', async () => {
    const { auth } = await import('@/lib/auth');
    const ctx = await auth.$context;
    for (const u of manifest.users) expect(u.cookieName).toBe(ctx.authCookies.sessionToken.name);
  });
});

describe('seam 1 — the seed’s target guard fails closed', () => {
  it('without LOADTEST_PRODUCTION_DB_HOSTS, and on a target that is in it', async () => {
    const out = join(dir, 'refused.json');
    expect(
      await runSeed(
        ['--tag', TAG, '--out', out],
        seedEnv({ LOADTEST_PRODUCTION_DB_HOSTS: undefined }),
        () => {},
      ),
    ).not.toBe(0);
    const host = endpointHost(process.env['DATABASE_URL']) ?? 'localhost';
    expect(
      await runSeed(
        ['--tag', TAG, '--out', out],
        seedEnv({ LOADTEST_PRODUCTION_DB_HOSTS: host }),
        () => {},
      ),
    ).not.toBe(0);
  });
});
