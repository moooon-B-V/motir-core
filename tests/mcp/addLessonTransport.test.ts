import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import * as route from '@/app/api/mcp/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { PermissionKey } from '@/lib/permissions/catalog';

// MOTIR-3362 — `add_lesson` through the REAL MCP transport: the gate proved
// WIRED rather than merely written.
//
// Every case enters at `app/api/mcp/route.ts` with a bearer token, the way an
// agent does — not by calling the tool function, which skips exactly the layers
// that could be wrong (the auth gate, the permission gate, the rate-limit gate,
// and the registration-time schema rewrite).
//
// ⚠️ UPSTREAM IS STUBBED AT THE HTTP BOUNDARY, never by mocking
// `motirAiClient`'s exported function. A mock one level up would not exercise
// the request BODY this feature's contract depends on — and the body is the half
// that carries the acting project.
//
// Four properties, each chosen because the natural way to write it passes under
// a broken implementation:
//
//   1. An unpermitted token is refused AND NO UPSTREAM REQUEST IS ISSUED.
//      Asserted as the absence of the call: a check that ran after the request
//      had gone out reads identically from the tool result.
//   2. A permitted token creates, and the outgoing request NAMES the acting
//      project — asserted on the serialized body.
//   3. `scope` is refused by the STRICT-INPUT seam. This asserts `add_lesson`
//      INHERITS MOTIR-3342's rewrite, not that the tool implements anything —
//      and it goes red the moment somebody declares the schema `.passthrough()`,
//      which is the change it exists to catch.
//   4. The near-duplicate refusal survives all four hops out, id and title
//      intact.

const ENDPOINT = 'http://localhost/api/mcp';

const ARGS = {
  title: 'Pin the repository on every card that ships code',
  body: 'A card with no repository pinned goes to whichever checkout happens to be first.',
  why: 'It cost a day in the billing epic.',
  howToApply: 'Set the target repository before sealing a card that ships code.',
};

/** A `fetch` that dispatches the SDK transport straight into the real route. */
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
  const client = new Client({ name: 'add-lesson-transport', version: '0.0.0' });
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

function wireLesson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'les_1',
    scope: 'tenant',
    aiProjectId: 'aip_1',
    mistakeType: 'regular_planning',
    title: ARGS.title,
    body: ARGS.body,
    why: ARGS.why,
    howToApply: ARGS.howToApply,
    categories: [],
    kinds: [],
    types: [],
    phases: [],
    sourceRef: null,
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastOccurredAt: '2026-08-02T00:00:00.000Z',
    recurrenceCount: 1,
    injected: true,
    injectionBlock: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/**
 * Stub the UPSTREAM at the HTTP boundary. The MCP transport does not use global
 * `fetch` (it is handed `routeFetch`), so this intercepts motir-ai's traffic and
 * nothing else — which is what lets "no upstream request was issued" be a real
 * assertion rather than a proxy for one.
 */
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

const rendered = (result: unknown) => JSON.stringify(result);

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

describe('add_lesson over the real transport — the gate', () => {
  it('a token WITHOUT the permission is refused, and no upstream request is issued', async () => {
    const fx = await makeWorkItemFixture();
    const withheld = GRANTABLE_PERMISSIONS.filter((k) => k !== 'lesson:manage');
    const client = await connect(await tokenWith(fx, withheld, 'no-lesson-manage'));
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await client.callTool({
      name: 'add_lesson',
      arguments: { projectKey: fx.projectIdentifier, ...ARGS },
    });

    expect(result.isError).toBe(true);
    expect(rendered(result)).toContain('lesson:manage');
    // THE assertion. Not "it returned an error" — that a request never left.
    expect(upstream.calls).toEqual([]);
  });

  it('a token WITH the permission creates, and the request names the ACTING project', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await client.callTool({
      name: 'add_lesson',
      arguments: { projectKey: fx.projectIdentifier, ...ARGS },
    });

    expect(result.isError).toBeFalsy();
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toContain('/v1/lessons');

    // On the SERIALIZED body — the only form motir-ai sees, and the half a mock
    // of `motirAiClient` would not have exercised.
    const body = JSON.parse(upstream.inits[0]!.body as string) as Record<string, unknown>;
    expect(body['coreProjectId']).toBe(fx.projectId);
    expect(body['coreWorkspaceId']).toBe(fx.workspaceId);
  });
});

describe('add_lesson over the real transport — no caller can create a GLOBAL lesson', () => {
  it('a body carrying `scope` is refused by the strict-input seam, naming the key', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'scope-attempt'));
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await client.callTool({
      name: 'add_lesson',
      arguments: { projectKey: fx.projectIdentifier, ...ARGS, scope: 'global' },
    });

    expect(result.isError).toBe(true);
    // NAMED, not dropped. The refusal comes from `lib/mcp/strictInput.ts`, which
    // rewrites every tool's schema to `strict` at the registration seam — so what
    // this asserts is that `add_lesson` INHERITS the guard. It would stop
    // inheriting it the moment someone declared the schema `.passthrough()`,
    // which is exactly the change this case exists to catch.
    expect(rendered(result)).toContain('scope');
    // And nothing was written: refused before the boundary, like the gate above.
    expect(upstream.calls).toEqual([]);
  });

  it('the tool advertises NO scope argument at all', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'list'));

    const { tools } = await client.listTools();
    const addLesson = tools.find((t) => t.name === 'add_lesson');

    expect(addLesson).toBeTruthy();
    const props = (addLesson?.inputSchema as { properties?: Record<string, unknown> }).properties;
    // The contract is the ABSENCE of the argument, which is stronger than a
    // validation rule: there is nothing to forget to check.
    expect(Object.keys(props ?? {})).not.toContain('scope');
    // And the published schema is closed, which is what makes the refusal above
    // possible at all.
    expect(
      (addLesson?.inputSchema as { additionalProperties?: boolean }).additionalProperties,
    ).toBe(false);
  });
});

describe('add_lesson over the real transport — tenancy', () => {
  it('a token bound to project A cannot create a lesson on project B', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connect(await tokenWith(mine, GRANTABLE_PERMISSIONS, 'cross-tenant'));
    const upstream = stubUpstream(() => jsonResponse(wireLesson(), 201));

    const result = await client.callTool({
      name: 'add_lesson',
      arguments: { projectKey: theirs.projectIdentifier, ...ARGS },
    });

    expect(result.isError).toBe(true);
    // Nothing reached motir-ai — a cross-tenant write must not even be attempted,
    // and the other project's existence is not confirmed by the answer.
    expect(upstream.calls).toEqual([]);
  });
});

describe('add_lesson over the real transport — the near-duplicate answer', () => {
  it('reaches the caller with the existing lesson’s id and title intact', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'dup'));
    stubUpstream(() =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'conflict',
          status: 409,
          code: 'conflict',
          detail:
            'a lesson very like this one already applies to this project: les_existing — "Pin the repository"',
        },
        409,
      ),
    );

    const result = await client.callTool({
      name: 'add_lesson',
      arguments: { projectKey: fx.projectIdentifier, ...ARGS },
    });

    expect(result.isError).toBe(true);
    // Four hops — motir-ai → client → service → tool → transport — and neither
    // half may be flattened on any of them. The id is how the caller reaches the
    // existing row; the title is how it judges whether rewording is right.
    expect(rendered(result)).toContain('les_existing');
    expect(rendered(result)).toContain('Pin the repository');
  });
});
