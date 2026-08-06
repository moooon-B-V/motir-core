import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_PAYLOADS } from '@/lib/mcp/payloads/registry';
import { checkPayloadDrift } from '@/lib/mcp/payloads/driftGuard';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import { createV1ProjectCaller, type V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../helpers/db';

// TWO-SURFACE CONFORMANCE (Story 11.6 · Subtask 11.6.8 — MOTIR-2234).
//
// This story ships no UI, so its end-to-end proof is **two live surfaces, one
// database, and a diff**. MOTIR-2232's guard compares SCHEMAS; this compares what
// the two surfaces actually EMIT at runtime, which is a different fact and the
// one a consumer experiences.
//
// ⚠️ WHY IT IS NOT REDUNDANT. Two mappers can validate against ONE schema and
// still disagree: a mapper reading `updatedAt` where it should read `createdAt`
// produces a payload that is structurally perfect, passes every schema
// assertion, and is simply wrong. A mapper spreading edges from the wrong lookup
// produces edges belonging to a different item. Those are not exotic mistakes —
// they are the ordinary result of rewriting thirty mapping functions in a week,
// and no amount of schema checking sees them, because the SHAPE is exactly
// right. The last test in this file PLANTS one and proves this suite catches it
// while `checkPayloadDrift` does not.
//
// The arrangement: ONE socket serving both `/api/mcp` and `/api/v1/**` from the
// real route modules, ONE PAT, real Postgres. Nothing stands in for anything.
//
// The harness ALREADY resolves Next.js dynamic segments (`/work-items/[key]`) —
// checked before writing, per the card, and REUSED rather than forked.

let server: McpTestServer;
let caller: V1ProjectCaller;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  caller = await createV1ProjectCaller({
    scopes: ['read', 'work_items:write', 'sprints:write'],
  });
});

afterEach(() => {
  /* the socket outlives each test; rows are truncated above */
});

/** An MCP client speaking to the REAL `/api/mcp` over the REAL socket. */
async function mcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${caller.token}` } },
  });
  const client = new Client({ name: 'two-surface-conformance', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** A v1 GET over the same socket, with the same PAT. */
async function restGet(path: string): Promise<{ status: number; body: never }> {
  const response = await fetch(`${server.url}${path}`, { headers: caller.headers });
  return { status: response.status, body: (await response.json()) as never };
}

/** Call one tool and hand back its `structuredContent`. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as Record<string, unknown>;
}

describe('the SAME row through BOTH surfaces carries the same values under the same keys', () => {
  it('a work item WITH CHILDREN and edges — the divergence that started this story', async () => {
    const story = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'The story' },
      caller.ctx,
    );
    const first = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'First',
        parentId: story.id,
      },
      caller.ctx,
    );
    const second = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'Second',
        parentId: story.id,
      },
      caller.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: second.id, toId: first.id, kind: 'is_blocked_by' },
      caller.ctx,
    );

    const client = await mcpClient();
    const viaMcp = await callTool(client, 'get_work_item', { key: story.identifier });
    const viaRest = await restGet(`/api/v1/work-items/${story.identifier}`);
    await client.close();

    expect(viaRest.status).toBe(200);

    const mcpChildren = viaMcp.children as Record<string, unknown>[];
    const restChildren = (viaRest.body as { children: Record<string, unknown>[] }).children;

    // ⚠️ NON-VACUOUS FIRST. Every comparison below is a loop, and a loop over an
    // empty list passes while asserting nothing — the exact way a conformance
    // suite goes green without checking anything.
    expect(restChildren).toHaveLength(2);
    expect(mcpChildren).toHaveLength(2);
    // Same rows, same order, addressed the same way.
    expect(mcpChildren.map((c) => c.key)).toEqual(restChildren.map((c) => c.key));

    // The PER-CHILD dependency edges — the exact divergence MOTIR-1849 was
    // filed for. Compared value by value across the two live surfaces.
    for (const restChild of restChildren) {
      const mcpChild = mcpChildren.find((c) => c.key === restChild.key)!;
      expect(mcpChild, `MCP is missing child ${String(restChild.key)}`).toBeDefined();
      expect(mcpChild.dependencies).toEqual(restChild.dependencies);
      // …and every other field the SHARED schema declares.
      for (const field of Object.keys(restChild)) {
        expect(mcpChild[field], `child.${field} disagrees`).toEqual(restChild[field]);
      }
    }
  });

  it('an EMPTY collection agrees — `[]` on both, never absent on one', async () => {
    const lonely = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'No children' },
      caller.ctx,
    );
    const client = await mcpClient();
    const viaMcp = await callTool(client, 'get_work_item', { key: lonely.identifier });
    const viaRest = await restGet(`/api/v1/work-items/${lonely.identifier}`);
    await client.close();

    expect(viaMcp.children).toEqual([]);
    expect((viaRest.body as { children: unknown[] }).children).toEqual([]);
  });

  it('a NULL field is null on both — never null here and absent there', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Unassigned' },
      caller.ctx,
    );
    const client = await mcpClient();
    const viaMcp = await callTool(client, 'get_work_item', { key: item.identifier });
    const viaRest = await restGet(`/api/v1/work-items/${item.identifier}`);
    await client.close();

    const mcpItem = viaMcp.item as Record<string, unknown>;
    expect(mcpItem.assigneeId).toBeNull();
    expect((viaRest.body as Record<string, unknown>).assigneeId).toBeNull();
    // Present-and-null, not absent — to a typed client those are different.
    expect('assigneeId' in mcpItem).toBe(true);
    expect('assigneeId' in (viaRest.body as object)).toBe(true);
  });

  it('the READY set agrees row for row, under the same keys', async () => {
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Ready A' },
      caller.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Ready B' },
      caller.ctx,
    );

    const client = await mcpClient();
    const viaMcp = await callTool(client, 'list_ready', { projectKey: caller.projectKey });
    const viaRest = await restGet(`/api/v1/projects/${caller.projectKey}/ready`);
    await client.close();

    const mcpRows = viaMcp.items as Record<string, unknown>[];
    const restRows = (viaRest.body as { items: Record<string, unknown>[] }).items;
    expect(restRows.length).toBeGreaterThanOrEqual(2); // non-vacuous
    expect(mcpRows.map((r) => r.key)).toEqual(restRows.map((r) => r.key));

    for (const restRow of restRows) {
      const mcpRow = mcpRows.find((r) => r.key === restRow.key)!;
      for (const field of Object.keys(restRow)) {
        expect(mcpRow[field], `ready.${field} disagrees`).toEqual(restRow[field]);
      }
    }
  });

  it('a SPRINT agrees field for field', async () => {
    const sprint = await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Sprint 1', goal: 'ship it' },
      caller.ctx,
    );
    const client = await mcpClient();
    const viaMcp = await callTool(client, 'list_sprints', { projectKey: caller.projectKey });
    const viaRest = await restGet(`/api/v1/projects/${caller.projectKey}/sprints`);
    await client.close();

    const mcpRow = (viaMcp.sprints as Record<string, unknown>[]).find((s) => s.id === sprint.id)!;
    const restRow = (viaRest.body as { items: Record<string, unknown>[] }).items.find(
      (s) => s.id === sprint.id,
    )!;
    expect(mcpRow).toBeDefined();
    expect(restRow).toBeDefined();
    expect(Object.keys(restRow).length).toBeGreaterThan(5); // non-vacuous
    for (const field of Object.keys(restRow)) {
      expect(mcpRow[field], `sprint.${field} disagrees`).toEqual(restRow[field]);
    }
  });

  it('a PROJECT agrees on every field the shared schema declares', async () => {
    const client = await mcpClient();
    const viaMcp = await callTool(client, 'list_projects', {});
    const viaRest = await restGet('/api/v1/projects');
    await client.close();

    const mcpRow = (viaMcp.projects as Record<string, unknown>[]).find(
      (p) => p.key === caller.projectKey,
    )!;
    const restRow = (viaRest.body as { items: Record<string, unknown>[] }).items.find(
      (p) => p.key === caller.projectKey,
    )!;
    expect(Object.keys(restRow).length).toBeGreaterThan(2); // non-vacuous
    for (const field of Object.keys(restRow)) {
      expect(mcpRow[field], `project.${field} disagrees`).toEqual(restRow[field]);
    }
  });

  it('a CASCADE-BLOCKED readiness verdict agrees on both surfaces', async () => {
    const blocker = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Blocker' },
      caller.ctx,
    );
    const blocked = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Blocked' },
      caller.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      caller.ctx,
    );

    const client = await mcpClient();
    const viaMcp = await callTool(client, 'get_work_item', { key: blocked.identifier });
    const viaRest = await restGet(`/api/v1/work-items/${blocked.identifier}`);
    await client.close();

    const mcpReadiness = viaMcp.readiness as { ready: boolean; openBlockers: { key?: string }[] };
    const restReadiness = (viaRest.body as { readiness: { ready: boolean } }).readiness;
    expect(mcpReadiness.ready).toBe(false);
    expect(restReadiness.ready).toBe(false);
  });
});

describe('what did NOT change, asserted from OUTSIDE the process', () => {
  it('every tool’s NAME, description, argument shape and scope is intact over a live tools/list', async () => {
    // The freedom the epic's architecture depends on. Thirty-odd files were
    // rewritten, which is exactly the circumstance in which a description gets
    // "tidied" in passing — so this reads the LIVE advertisement over a socket
    // rather than trusting the source.
    const client = await mcpClient();
    const { tools } = await client.listTools();
    await client.close();

    const advertised = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of MCP_TOOL_NAMES) {
      const tool = advertised.get(name);
      expect(tool, `tool "${name}" vanished from tools/list`).toBeDefined();
      expect(tool!.description, `"${name}" lost its description`).toBeTruthy();
      expect(tool!.inputSchema, `"${name}" lost its input schema`).toBeDefined();
      // Every tool still maps to exactly the scope it did before the story.
      expect(TOOL_SCOPES[name], `"${name}" lost its scope`).toBeTruthy();
    }
    expect(advertised.size).toBe(MCP_TOOL_NAMES.length);
  });

  it('NO tool advertises an `outputSchema` — the Q1 decision, checked from the wire', async () => {
    // ADR Amendment 7 Q1: we derive internally and deliberately do NOT publish
    // the shape, because `tools/list` is caller-visible surface and the SDK would
    // turn a drift into a runtime error in front of an agent.
    const client = await mcpClient();
    const { tools } = await client.listTools();
    await client.close();
    for (const tool of tools) {
      expect(tool.outputSchema, `"${tool.name}" now advertises an outputSchema`).toBeUndefined();
    }
  });
});

describe('the planted MAPPER BUG — why the schema guard is not enough', () => {
  it('a right-shape / WRONG-SOURCE payload passes the schema guard and FAILS here', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'Subject' },
      caller.ctx,
    );
    const child = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'A child',
        parentId: item.id,
      },
      caller.ctx,
    );

    const client = await mcpClient();
    const viaMcp = await callTool(client, 'get_work_item', { key: item.identifier });
    const viaRest = await restGet(`/api/v1/work-items/${item.identifier}`);
    await client.close();

    const honest = (viaMcp.children as Record<string, unknown>[])[0]!;
    const restChild = (viaRest.body as { children: Record<string, unknown>[] }).children[0]!;

    // Sanity: the real payloads agree.
    expect(honest.title).toEqual(restChild.title);

    // ── Now PLANT the bug: the right shape, the wrong SOURCE field. ──────────
    // `title` reads the parent's title instead of the child's. Every field is
    // present, every type is right — this is what a mis-wired mapper produces.
    const planted = { ...honest, title: 'Subject' };
    expect(planted.title).not.toBe(child.title);

    // THE SCHEMA GUARD IS SATISFIED. It compares SHAPES, and the shape is perfect.
    expect(
      checkPayloadDrift(TOOL_PAYLOADS.get_work_item!, { ...viaMcp, children: [planted] }),
    ).toEqual([]);

    // THIS SUITE CATCHES IT, because it compares VALUES against the other
    // surface reading the same row. That is the whole reason both checks exist.
    expect(planted.title).not.toEqual(restChild.title);
  });

  it('an edge block spread from the WRONG lookup is caught the same way', async () => {
    const a = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'Parent' },
      caller.ctx,
    );
    const first = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'subtask', title: 'First', parentId: a.id },
      caller.ctx,
    );
    const second = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'subtask', title: 'Second', parentId: a.id },
      caller.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: second.id, toId: first.id, kind: 'is_blocked_by' },
      caller.ctx,
    );

    const client = await mcpClient();
    const viaMcp = await callTool(client, 'get_work_item', { key: a.identifier });
    const viaRest = await restGet(`/api/v1/work-items/${a.identifier}`);
    await client.close();

    const mcpChildren = viaMcp.children as Record<string, unknown>[];
    const restChildren = (viaRest.body as { children: Record<string, unknown>[] }).children;

    // Honest: each child's edges are ITS OWN, and both surfaces say so.
    expect(restChildren).toHaveLength(2); // non-vacuous
    for (const restChild of restChildren) {
      const mcpChild = mcpChildren.find((c) => c.key === restChild.key)!;
      expect(mcpChild.dependencies).toEqual(restChild.dependencies);
    }

    // Planted: child[0] gets child[1]'s edge block — structurally flawless.
    const swapped = mcpChildren.map((c, i) => ({
      ...c,
      dependencies: mcpChildren[mcpChildren.length - 1 - i]!.dependencies,
    }));
    expect(checkPayloadDrift(TOOL_PAYLOADS.get_work_item!, { children: swapped })).toEqual([]);
    // …and wrong, which only a value comparison against the other surface sees.
    expect(swapped[0]!.dependencies).not.toEqual(restChildren[0]!.dependencies);
  });
});
