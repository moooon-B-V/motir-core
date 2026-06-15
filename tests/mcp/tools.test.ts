import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runNextReady } from '@/lib/mcp/tools/nextReady';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP read tools (Subtask 7.8.4) over real Postgres. Two layers:
//  - an in-memory MCP client↔server round-trip (initialize → tools/list →
//    tools/call) — the acceptance-criterion contract, plus the 404-not-403
//    cross-tenant behaviour surfaced as a tool error;
//  - direct `run*` adapter calls for pagination + filter + empty-set nuances.
// The server is built with a fixed-context resolver (the auth gate is unit-
// tested separately in auth.test.ts), so these exercise the tool surface
// without the transport's bearer plumbing.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function make(
  fx: WorkItemFixture,
  opts: { title?: string; assigneeId?: string | null } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: opts.title ?? 'Item',
      assigneeId: opts.assigneeId ?? null,
      descriptionMd: opts.title ? `Body for ${opts.title}` : null,
    },
    fx.ctx,
  );
}

/** Connect an in-memory MCP client to a server bound to `ctx`. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP read tools — client round-trip', () => {
  it('initialize → tools/list returns the three read tools with stable names', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    // Each tool advertises an input schema (the `tools/call` contract).
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
    await client.close();
  });

  it('get_work_item returns the issue-detail aggregate via structuredContent', async () => {
    const fx = await makeWorkItemFixture();
    const x = await make(fx, { title: 'Wire MCP' });
    const client = await connectClient(fx.ctx);

    const res = await client.callTool({ name: 'get_work_item', arguments: { key: x.identifier } });
    expect(res.isError).toBeFalsy();
    const detail = res.structuredContent as { item: { identifier: string; title: string } };
    expect(detail.item.identifier).toBe(x.identifier);
    expect(detail.item.title).toBe('Wire MCP');
    // Case-insensitive key resolution (parity with the route).
    const lower = await client.callTool({
      name: 'get_work_item',
      arguments: { key: x.identifier.toLowerCase() },
    });
    expect((lower.structuredContent as { item: { identifier: string } }).item.identifier).toBe(
      x.identifier,
    );
    await client.close();
  });

  it('get_work_item: a missing item and a cross-tenant key both surface as not-found (no leak)', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const missing = await client.callTool({
      name: 'get_work_item',
      arguments: { key: 'PROD-9999' },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('WORK_ITEM_NOT_FOUND');

    // A project that exists only in ANOTHER workspace must be indistinguishable
    // from a non-existent one (404-not-403). Build a second tenant + item, query
    // it through the first tenant's context.
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const otherItem = await make(other, { title: 'Secret' });
    const probe = await client.callTool({
      name: 'get_work_item',
      arguments: { key: otherItem.identifier },
    });
    expect(probe.isError).toBe(true);
    expect(JSON.stringify(probe.content)).toContain('PROJECT_NOT_FOUND');
    await client.close();
  });

  it('list_ready returns the ready set; next_ready dispatches one + walks via excludeIds', async () => {
    const fx = await makeWorkItemFixture();
    const a = await make(fx, { title: 'A' });
    const b = await make(fx, { title: 'B' });
    const client = await connectClient(fx.ctx);

    const list = await client.callTool({ name: 'list_ready', arguments: { projectKey: 'PROD' } });
    const page = list.structuredContent as { items: { key: string }[]; nextCursor: string | null };
    expect(page.items.map((i) => i.key).sort()).toEqual([a.identifier, b.identifier].sort());

    const first = await client.callTool({ name: 'next_ready', arguments: { projectKey: 'PROD' } });
    const firstItem = (first.structuredContent as { item: { key: string; runCommand: string } })
      .item;
    expect(firstItem.key).toMatch(/^PROD-\d+$/);
    expect(firstItem.runCommand).toBe(`motir run ${firstItem.key}`);

    // Exclude the dispatched one → the other; exclude both → empty (item null).
    const idOf = (k: string) => [a, b].find((w) => w.identifier === k)!.id;
    const second = await client.callTool({
      name: 'next_ready',
      arguments: { projectKey: 'PROD', excludeIds: [idOf(firstItem.key)] },
    });
    const secondItem = (second.structuredContent as { item: { key: string } | null }).item;
    expect(secondItem?.key).not.toBe(firstItem.key);

    const none = await client.callTool({
      name: 'next_ready',
      arguments: { projectKey: 'PROD', excludeIds: [a.id, b.id] },
    });
    expect((none.structuredContent as { item: unknown }).item).toBeNull();
    await client.close();
  });

  it('whoami resolves the acting user + active workspace (the CLI auth-status read)', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const res = await client.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBeFalsy();
    const id = res.structuredContent as {
      user: { id: string; name: string; email: string };
      workspace: { id: string; slug: string } | null;
    };
    expect(id.user.id).toBe(fx.owner.id);
    expect(id.user.email).toBe(fx.owner.email);
    expect(id.workspace?.id).toBe(fx.workspace.id);
    await client.close();
  });
});

describe('MCP read tools — adapters', () => {
  it('list_ready paginates: limit caps the page and nextCursor fetches the rest', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'A' });
    await make(fx, { title: 'B' });

    const p1 = (await runListReady({ projectKey: 'PROD', limit: 1 }, fx.ctx)).structuredContent as {
      items: { key: string }[];
      nextCursor: string | null;
    };
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = (
      await runListReady({ projectKey: 'PROD', limit: 1, cursor: p1.nextCursor! }, fx.ctx)
    ).structuredContent as { items: { key: string }[] };
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.key).not.toBe(p1.items[0]!.key);
  });

  it('list_ready assigneeId="unassigned" filters to the unassigned bucket', async () => {
    const fx = await makeWorkItemFixture();
    const mine = await make(fx, { title: 'Mine', assigneeId: fx.ownerId });
    const free = await make(fx, { title: 'Free', assigneeId: null });

    const res = (await runListReady({ projectKey: 'PROD', assigneeId: 'unassigned' }, fx.ctx))
      .structuredContent as { items: { key: string }[] };
    const keys = res.items.map((i) => i.key);
    expect(keys).toContain(free.identifier);
    expect(keys).not.toContain(mine.identifier);
  });

  it('next_ready returns item:null when nothing is ready', async () => {
    const fx = await makeWorkItemFixture();
    const res = await runNextReady({ projectKey: 'PROD' }, fx.ctx);
    expect((res.structuredContent as { item: unknown }).item).toBeNull();
    expect(res.isError).toBeFalsy();
  });
});
