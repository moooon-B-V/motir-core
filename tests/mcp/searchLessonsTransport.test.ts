import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import * as route from '@/app/api/mcp/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { PermissionKey } from '@/lib/permissions/catalog';

// MOTIR-3481 — `search_lessons` through the REAL MCP transport: the tool proved
// REACHABLE and GATED rather than merely written.
//
// Every case enters at `app/api/mcp/route.ts` with a bearer token, the way an
// agent does — never by calling the tool function, which skips exactly the
// layers that could be wrong (the auth gate, the permission gate, the
// registration-time schema rewrite, and the registry itself).
//
// ⚠️ WHAT THIS FILE DOES **NOT** ASSERT: the SCOPE PREDICATE. It is SQL, it is
// enforced in motir-ai, and a test in this repo could only mock it and would
// then be asserting its own harness. MOTIR-3479 owns that half, against a real
// database. Here motir-ai is doubled at its HTTP boundary, which is what lets
// "no upstream request was issued" be a real assertion rather than a proxy.
//
// The arms are chosen because the natural way to write each one passes under a
// broken implementation:
//
//   1. GATED — asserted as the ABSENCE of the upstream call. A check that ran
//      after the request had gone out reads identically from the tool result.
//   2. GRANTED — asserted against `CLI_TOKEN_GRANT` as the EXPORTED CONSTANT,
//      not a re-listed copy, so dropping the key fails here.
//   3. The three outcomes — the two EMPTY ones asserted by COMPARING them.
//      Checking either alone passes against an implementation that returns the
//      same thing for both, which is the defect.

const ENDPOINT = 'http://localhost/api/mcp';
const QUERY = 'counting a population from a working tree instead of a ref';

function routeFetch(token?: string): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init.headers ?? {});
    if (token) headers.set('authorization', `Bearer ${token}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
    return handler(new Request(url, { ...init, headers }) as never);
  }) as unknown as typeof fetch;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: routeFetch(token),
  });
  const client = new Client({ name: 'search-lessons-transport', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function tokenWith(
  fx: WorkItemFixture,
  permissions: readonly PermissionKey[],
  label: string,
): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...permissions],
  });
  return token;
}

function rankedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_1',
    title: 'a count taken from a working tree is not a property of the ref',
    body: 'Somebody counted with `find` over a tree they had been editing.',
    howToApply: 'Re-measure on a ref — `git ls-tree` — before quoting a number.',
    scope: 'global',
    kinds: [],
    types: ['code'],
    phases: ['deepen'],
    distance: 0.12,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/** Stub the UPSTREAM at the HTTP boundary — the MCP transport uses `routeFetch`,
 *  so this intercepts motir-ai's traffic and nothing else. */
function stubUpstream(response: () => Response): { calls: string[]; inits: RequestInit[] } {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      calls.push(String(input));
      inits.push((init ?? {}) as RequestInit);
      return response();
    }),
  );
  return { calls, inits };
}

/** The rendered prose — not `JSON.stringify`, which escapes the quotes the
 *  unavailable message deliberately contains. */
function renderedText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

async function search(
  client: Client,
  fx: WorkItemFixture,
  args: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'search_lessons',
    arguments: { projectKey: fx.projectIdentifier, query: QUERY, ...args },
  });
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the tool is REGISTERED and its surface matches what the description promises', () => {
  it('appears in tools/list with `query` plus the three optional axes', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'search_lessons');
    expect(tool, 'search_lessons is not registered on the shipped server').toBeDefined();

    const props = (
      tool!.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    ).properties;
    // A caller reading the surface must find what the description promises.
    for (const field of ['projectKey', 'query', 'kinds', 'types', 'phases', 'limit']) {
      expect(props, `tools/list omits \`${field}\``).toHaveProperty(field);
    }
    const required = (tool!.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain('query');
    expect(required).not.toContain('kinds');
  });
});

describe('GATED — a token without the read key never reaches the corpus', () => {
  it('is refused, and NO upstream request is issued', async () => {
    const fx = await makeWorkItemFixture();
    const withheld = GRANTABLE_PERMISSIONS.filter((k) => k !== 'lesson:view');
    const client = await connect(await tokenWith(fx, withheld, 'no-lesson-view'));
    const upstream = stubUpstream(() => jsonResponse({ lessons: [rankedRow()] }));

    const result = await search(client, fx);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('lesson:view');
    // THE assertion — not "it returned an error", but that a request never left.
    expect(upstream.calls).toEqual([]);
  });
});

describe('GRANTED — the sandboxed-run grant CAN call it', () => {
  it('a context carrying CLI_TOKEN_GRANT reaches the corpus', async () => {
    // ⚠️ The grant is taken from the EXPORTED CONSTANT rather than re-listed
    // here. That is what makes this arm fail if `lesson:view` is dropped from
    // it — the failure that otherwise ships green, with every other suite
    // passing against a workspace PAT while the one caller this story was built
    // for gets a refusal it reads as an outage.
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli-grant'));
    const upstream = stubUpstream(() => jsonResponse({ lessons: [rankedRow()] }));

    const result = await search(client, fx);

    expect(result.isError, `CLI_TOKEN_GRANT cannot call search_lessons`).toBeFalsy();
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toContain('/v1/lessons/search');
  });

  it('the grant carries the key this tool actually asserts', () => {
    // Stated as the relationship, so renaming the permission cannot leave a
    // passing test beside a broken grant.
    expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS.search_lessons);
  });
});

describe('MATCHED — the text arrives, marked with the scope it came from', () => {
  it('returns rows of BOTH scopes with their text', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    stubUpstream(() =>
      jsonResponse({
        lessons: [
          rankedRow({ id: 'g', scope: 'global', title: 'the shared corpus row' }),
          rankedRow({ id: 't', scope: 'tenant', title: 'our own row', distance: 0.3 }),
        ],
      }),
    );

    const result = await search(client, fx);
    const text = renderedText(result);

    expect(text).toContain('the shared corpus row');
    expect(text).toContain('our own row');
    expect(text).toContain('global');
    expect(text).toContain('tenant');
    // Enough to act on without a second call.
    expect(text).toContain('Re-measure on a ref');
  });

  it('names the acting project on the SERIALIZED upstream body', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const upstream = stubUpstream(() => jsonResponse({ lessons: [] }));

    await search(client, fx, { kinds: ['bug'] });

    const body = JSON.parse(upstream.inits[0]!.body as string) as Record<string, unknown>;
    expect(body['coreProjectId']).toBe(fx.projectId);
    expect(body['coreWorkspaceId']).toBe(fx.workspaceId);
    expect(body['query']).toBe(QUERY);
    expect(body['kinds']).toEqual(['bug']);
    // The axes the caller did not name never became `[]` on the way through.
    expect(body).not.toHaveProperty('types');
    expect(body).not.toHaveProperty('phases');
  });
});

describe('⚠️ THE TWO EMPTY OUTCOMES — an empty result is not a failure, and not an outage', () => {
  it('NOTHING MATCHED renders as a readable message, not an error and not an empty string', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    stubUpstream(() => jsonResponse({ lessons: [] }));

    const result = await search(client, fx);

    expect(result.isError).toBeFalsy();
    const text = renderedText(result);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toMatch(/no recorded lesson matches/i);
  });

  it('UNREACHABLE renders as a DISTINCT readable outcome, not as a failed call', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    stubUpstream(() => jsonResponse({ code: 'internal_error', status: 503 }, 503));

    const result = await search(client, fx);

    expect(result.isError).toBeFalsy();
    expect(renderedText(result)).toMatch(/could NOT BE REACHED/i);
  });

  it('the two are DISTINGUISHABLE — asserted by COMPARING them, not by checking one', async () => {
    // The arm the card names. Both carry no lessons; checking either in
    // isolation passes against an implementation that renders them identically,
    // which is exactly the defect — an agent that cannot tell them apart
    // proceeds believing it checked the corpus.
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    stubUpstream(() => jsonResponse({ lessons: [] }));
    const empty = await search(client, fx);

    vi.unstubAllGlobals();
    stubUpstream(() => jsonResponse({ code: 'internal_error', status: 503 }, 503));
    const down = await search(client, fx);

    expect(renderedText(empty)).not.toBe(renderedText(down));
    expect((empty.structuredContent as { outcome: string }).outcome).toBe('nothing-matched');
    expect((down.structuredContent as { outcome: string }).outcome).toBe('unavailable');
  });
});

describe('an axis value outside the shipped enum is a RESULT, not a transport throw', () => {
  it('comes back as a tool refusal that NAMES the legal set', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const upstream = stubUpstream(() => jsonResponse({ lessons: [rankedRow()] }));

    // `callTool` must RESOLVE — a refusal an agent cannot read is not a refusal.
    const result = await search(client, fx, { types: ['not-a-member'] });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    // The legal set, named — not a bare "invalid enum value".
    for (const member of ['code', 'design', 'test', 'chore']) {
      expect(text).toContain(member);
    }
    // Refused, never silently dropped and never an empty result.
    expect(upstream.calls).toEqual([]);
  });

  it('a blank query is refused the same way — a result, and the pool is never asked', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const upstream = stubUpstream(() => jsonResponse({ lessons: [] }));

    const result = await search(client, fx, { query: '' });

    expect(result.isError).toBe(true);
    expect(upstream.calls).toEqual([]);
  });
});
