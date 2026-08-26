import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import * as route from '@/app/api/mcp/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { PermissionKey } from '@/lib/permissions/catalog';

// MOTIR-3554 — `reinforce_lesson` through the REAL MCP transport: the SEAM, and
// only the seam.
//
// Every case enters at `app/api/mcp/route.ts` with a bearer token, the way an
// agent does — never by calling the tool function, which skips exactly the
// layers that could be wrong (the auth gate, the permission gate, the
// registration-time schema rewrite, and the registry itself).
//
// ⚠️ WHAT THIS FILE DELIBERATELY DOES **NOT** ASSERT, because a clause
// dischargeable inside one repository belongs to that repository's card:
//
//   * The LEDGER's idempotency (that a replay writes nothing at all, and that
//     both counters are left byte-identical) — MOTIR-3550, against a real
//     database. Here the replay is asserted only as far as this seam can see
//     it: that `counted: false` SURVIVES to the caller and reads as a normal
//     answer rather than an error.
//   * The BOTH-SCOPES resolver, which is SQL — MOTIR-3551. What is asserted
//     here is the half a per-repo suite structurally cannot see: that nothing
//     between the MCP tool and the boundary narrows a global row back out.
//   * The generator's occurrence marker — MOTIR-3552.
//
// motir-ai is doubled at its HTTP boundary, which is what lets "no upstream
// request was issued" be a real assertion rather than a proxy.
//
// The arms are chosen because the natural way to write each one passes under a
// broken implementation:
//
//   1. GATED — asserted as the ABSENCE of the upstream call. A check that ran
//      after the request had gone out reads identically from the tool result.
//   2. GRANTED — asserted against `CLI_TOKEN_GRANT` as the EXPORTED CONSTANT,
//      and paired with the key it must NOT have gained. Asserting only that
//      reinforce works passes against a grant that also holds `lesson:manage`,
//      which is the trade this card exists to refuse.
//   3. The ROUND TRIP — the id is taken from the STRUCTURED payload, never
//      parsed out of the prose. Reading the prose would pass against a payload
//      that had stopped carrying the id, which is the exact defect the parent
//      card was itself corrected for.

const ENDPOINT = 'http://localhost/api/mcp';
const QUERY = 'recording that a mistake I already had a lesson for has happened again';
const OCCURRENCE = 'MOTIR-3547';

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
  const client = new Client({ name: 'reinforce-lesson-transport', version: '0.0.0' });
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

/** One ranked row as the teaching read returns it — GLOBAL, deliberately. */
function rankedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_global_1',
    title: 'a count taken from a working tree is not a property of the ref',
    body: 'Somebody counted with `find` over a tree they had been editing.',
    howToApply: 'Re-measure on a ref before quoting a number.',
    scope: 'global',
    kinds: [],
    types: ['code'],
    phases: ['deepen'],
    distance: 0.12,
    ...over,
  };
}

/** The reinforce route's answer. */
function reinforced(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_global_1',
    title: 'a count taken from a working tree is not a property of the ref',
    scope: 'global',
    lastOccurredAt: '2026-08-26T12:00:00.000Z',
    recurrenceCount: 5,
    counted: true,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/** Route motir-ai's traffic by PATH, so one stub can serve a search and a
 *  reinforce in the same test — which is what a round trip needs. */
function stubUpstream(handler: (url: string) => Response): {
  calls: string[];
  inits: RequestInit[];
} {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input);
      calls.push(url);
      inits.push((init ?? {}) as RequestInit);
      return handler(url);
    }),
  );
  return { calls, inits };
}

function renderedText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function structured(result: unknown): Record<string, unknown> {
  return ((result as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;
}

async function reinforce(
  client: Client,
  fx: WorkItemFixture,
  args: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'reinforce_lesson',
    arguments: {
      projectKey: fx.projectIdentifier,
      lessonId: 'les_global_1',
      occurrenceRef: OCCURRENCE,
      ...args,
    },
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

// ───────────────────────────────────────────────────────────────────────────
// 1. REACHABLE — it is on the shipped server, with the arguments it promises
// ───────────────────────────────────────────────────────────────────────────
describe('the tool is REGISTERED on the shipped server', () => {
  it('appears in tools/list requiring the lesson AND the occurrence', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'reinforce_lesson');
    expect(tool, 'reinforce_lesson is not registered on the shipped server').toBeDefined();

    const schema = tool?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['lessonId', 'occurrenceRef', 'projectKey'].sort(),
    );
    // `occurrenceRef` REQUIRED is the contract, not a nicety: without one,
    // "one occurrence counts once" is unenforceable.
    expect(schema.required ?? []).toContain('occurrenceRef');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE ROUND TRIP — the loop this whole parent exists to close
// ───────────────────────────────────────────────────────────────────────────
describe('search → reinforce, across the boundary', () => {
  it('takes the id from the STRUCTURED payload and reinforces that lesson', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const upstream = stubUpstream((url) =>
      url.includes('/reinforce')
        ? jsonResponse(reinforced())
        : jsonResponse({ lessons: [rankedRow()] }),
    );

    const found = await client.callTool({
      name: 'search_lessons',
      arguments: { projectKey: fx.projectIdentifier, query: QUERY },
    });

    // ⚠️ From the PAYLOAD, not the prose. The prose renders title / body /
    // howToApply and no id — reading it would pass against a payload that had
    // stopped carrying one, which is exactly the mistake this parent was
    // corrected for.
    const lessons = structured(found)['lessons'] as { id: string }[];
    expect(lessons[0]?.id).toBe('les_global_1');

    const result = await reinforce(client, fx, { lessonId: lessons[0]!.id });

    expect(result.isError).toBeFalsy();
    const post = upstream.calls.find((u) => u.includes('/reinforce'));
    expect(post).toContain('/v1/lessons/les_global_1/reinforce');
    expect(structured(result)['counted']).toBe(true);
    // The clock the whole feature exists to move, as the caller sees it.
    expect(structured(result)['lastOccurredAt']).toBe('2026-08-26T12:00:00.000Z');
  });

  // The half a per-repo suite structurally cannot see. motir-ai asserts the
  // resolver; this asserts nothing between the tool and the boundary narrows a
  // GLOBAL row back out — which is the row the curated corpus is made of.
  it('reinforces a GLOBAL row end to end, and says so', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    stubUpstream(() => jsonResponse(reinforced()));

    const result = await reinforce(client, fx);

    expect(result.isError).toBeFalsy();
    expect(structured(result)['scope']).toBe('global');
    expect(renderedText(result)).toContain('global');
  });

  it('sends the occurrence ref across the boundary verbatim', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const upstream = stubUpstream(() => jsonResponse(reinforced()));

    await reinforce(client, fx);

    const init = upstream.inits[upstream.calls.findIndex((u) => u.includes('/reinforce'))];
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    expect(body['occurrenceRef']).toBe(OCCURRENCE);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. GATED — asserted as the ABSENCE of the upstream call
// ───────────────────────────────────────────────────────────────────────────
describe('the gate is UPSTREAM of the boundary', () => {
  it('a token without `lesson:reinforce` is refused and motir-ai is NEVER called', async () => {
    const fx = await makeWorkItemFixture();
    const without = GRANTABLE_PERMISSIONS.filter((k) => k !== 'lesson:reinforce');
    const client = await connect(await tokenWith(fx, without, 'no-reinforce'));
    const upstream = stubUpstream(() => jsonResponse(reinforced()));

    const result = await reinforce(client, fx);

    expect(result.isError).toBe(true);
    // The assertion that distinguishes a gate BEFORE the boundary from one
    // after it — a refusal alone reads identically either way.
    expect(upstream.calls).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE GRANT SPLIT — through the transport that actually carries it
// ───────────────────────────────────────────────────────────────────────────
describe('a CLI-minted token', () => {
  it('can reinforce', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli'));
    stubUpstream(() => jsonResponse(reinforced()));

    const result = await reinforce(client, fx);

    expect(result.isError).toBeFalsy();
  });

  // The pair that makes the first assertion mean something. Asserting only that
  // reinforce works passes against a grant that ALSO holds `lesson:manage` —
  // the trade this card refused, checked through the real gate rather than by
  // re-reading the constant.
  it('CANNOT add a lesson — the grant carries reinforce and not manage', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli2'));
    const upstream = stubUpstream(() => jsonResponse({ id: 'les_x' }, 201));

    const result = await client.callTool({
      name: 'add_lesson',
      arguments: {
        projectKey: fx.projectIdentifier,
        title: 'x',
        body: 'y',
        why: 'z',
        howToApply: 'w',
        mistakeType: 'regular_planning',
      },
    });

    expect(result.isError).toBe(true);
    expect(upstream.calls).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. THE THREE OUTCOMES — asserted by COMPARING them, because checking one
//    alone passes against an implementation that conflates them
// ───────────────────────────────────────────────────────────────────────────
describe('recorded, already recorded, and unreachable are three different answers', () => {
  it('a REPLAY is a success that says it did not count', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    stubUpstream(() => jsonResponse(reinforced({ counted: false })));

    const result = await reinforce(client, fx);

    // NOT an error. A caller that had to catch something here would stop
    // recording after its first retry.
    expect(result.isError).toBeFalsy();
    expect(structured(result)['counted']).toBe(false);
    expect(renderedText(result)).toMatch(/already recorded/i);
  });

  it('an OUTAGE is distinguishable from both — it is an error, not a quiet success', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    stubUpstream(() => {
      throw new Error('ECONNREFUSED');
    });

    const result = await reinforce(client, fx);

    expect(result.isError).toBe(true);
  });

  it('the three answers are mutually distinguishable at the tool result', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    stubUpstream(() => jsonResponse(reinforced({ counted: true })));
    const recorded = await reinforce(client, fx);
    vi.unstubAllGlobals();

    stubUpstream(() => jsonResponse(reinforced({ counted: false })));
    const replay = await reinforce(client, fx);
    vi.unstubAllGlobals();

    stubUpstream(() => {
      throw new Error('ECONNREFUSED');
    });
    const outage = await reinforce(client, fx);

    // A lost occurrence reported as a success is the failure this whole parent
    // exists to remove, so the two successes must differ from each other AND
    // from the failure.
    expect(recorded.isError).toBeFalsy();
    expect(replay.isError).toBeFalsy();
    expect(outage.isError).toBe(true);
    expect(structured(recorded)['counted']).not.toBe(structured(replay)['counted']);
  });
});
