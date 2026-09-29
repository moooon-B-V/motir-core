import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runNextReady } from '@/lib/mcp/tools/nextReady';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
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
  await adminDb.$disconnect();
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

describe('MCP ready tools — the `lane` argument (MOTIR-6833)', () => {
  /** A story S with two subtasks, a childless bug B, and bug B2 holding one subtask. */
  async function laneTree(fx: WorkItemFixture) {
    const mk = (kind: 'story' | 'subtask' | 'bug', title: string, parentId?: string) =>
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
        fx.ctx,
      );
    const S = await mk('story', 'S');
    const s1 = await mk('subtask', 's1', S.id);
    const s2 = await mk('subtask', 's2', S.id);
    const B = await mk('bug', 'B');
    const B2 = await mk('bug', 'B2');
    const b1 = await mk('subtask', 'b1', B2.id);
    return { S, s1, s2, B, B2, b1 };
  }
  const keys = (items: { key: string }[]) => items.map((i) => i.key);

  it('list_ready defaults to the leaves lane — no bug, no subtask of a bug — in its order', async () => {
    const fx = await makeWorkItemFixture();
    const t = await laneTree(fx);
    const res = (await runListReady({ projectKey: 'PROD' }, fx.ctx)).structuredContent as {
      lane: string;
      items: { key: string; container: { key: string } | null }[];
    };
    expect(res.lane).toBe('leaf');
    const svc = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    expect(keys(res.items)).toEqual(keys(svc.items));
    expect(keys(res.items)).not.toContain(t.B.identifier);
    expect(keys(res.items)).not.toContain(t.b1.identifier);
    expect(res.items.find((i) => i.key === t.s1.identifier)?.container?.key).toBe(t.S.identifier);
  });

  it('list_ready { lane: bug } and { lane: container } return exactly their service lanes', async () => {
    const fx = await makeWorkItemFixture();
    await laneTree(fx);
    const bugs = (await runListReady({ projectKey: 'PROD', lane: 'bug' }, fx.ctx))
      .structuredContent as { items: { key: string }[] };
    const svcBugs = await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx);
    expect(keys(bugs.items)).toEqual(keys(svcBugs.items));

    const containers = (await runListReady({ projectKey: 'PROD', lane: 'container' }, fx.ctx))
      .structuredContent as {
      items: { key: string; readyLeafCount: number; runCommand: string }[];
    };
    const svcContainers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    expect(keys(containers.items)).toEqual(keys(svcContainers.items));
    expect(containers.items[0]).toMatchObject({ readyLeafCount: 2 });
    expect(containers.items[0]!.runCommand).toBe(`motir run ${containers.items[0]!.key}`);
  });

  it('list_ready { lane: container } says so when empty, then names each container, its assignee and its run', async () => {
    const fx = await makeWorkItemFixture();
    const text = (res: CallToolResult) => (res.content[0] as { text: string }).text;
    const empty = await runListReady({ projectKey: 'PROD', lane: 'container' }, fx.ctx);
    expect(text(empty)).toBe('No ready work in the container lane.');
    const noBugs = await runListReady({ projectKey: 'PROD', lane: 'bug' }, fx.ctx);
    expect(text(noBugs)).toBe('No ready work in the bug lane.');

    const t = await laneTree(fx);
    const owned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Owned', assigneeId: fx.ownerId },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'o1',
        parentId: owned.id,
        assigneeId: fx.ownerId,
      },
      fx.ctx,
    );
    const first = await runListReady({ projectKey: 'PROD', lane: 'container', limit: 1 }, fx.ctx);
    const cursor = (first.structuredContent as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    expect(text(first)).toMatch(/^1 runnable container:\n/);
    expect(text(first)).toContain(`More available — pass cursor: ${cursor}`);

    const all = text(await runListReady({ projectKey: 'PROD', lane: 'container' }, fx.ctx));
    expect(all).toMatch(/^2 runnable containers:\n/);
    expect(all).toContain(
      `${t.S.identifier} [story/medium] S — 2 of 2 ready — unassigned — run: motir run ${t.S.identifier}`,
    );
    expect(all).toMatch(
      new RegExp(`${owned.identifier} \\[story/\\w+\\] Owned — 1 of 1 ready — \\S`),
    );
    expect(all).not.toContain(`Owned — 1 of 1 ready — unassigned`);
    // …and an assigned LEAF names its assignee in the leaf lane's line.
    const leaves = text(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    expect(leaves).toMatch(new RegExp(`o1 \\(in ${owned.identifier}\\) — (?!unassigned)`));
  });

  it('next_ready never hands out a bug by default; lane bug and lane container take theirs', async () => {
    const fx = await makeWorkItemFixture();
    const t = await laneTree(fx);
    const leafIds = [t.s1.id, t.s2.id];

    const first = (await runNextReady({ projectKey: 'PROD' }, fx.ctx)).structuredContent as {
      item: { key: string; container: { key: string } | null } | null;
    };
    expect([t.s1.identifier, t.s2.identifier]).toContain(first.item?.key);
    expect(first.item?.container?.key).toBe(t.S.identifier);
    // With every leaf excluded, the default lane is exhausted — it never falls to a bug.
    const none = (await runNextReady({ projectKey: 'PROD', excludeIds: leafIds }, fx.ctx))
      .structuredContent as { item: unknown };
    expect(none.item).toBeNull();

    const bugs = await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx);
    const bug = (await runNextReady({ projectKey: 'PROD', lane: 'bug' }, fx.ctx))
      .structuredContent as { item: { key: string } | null };
    expect(bug.item?.key).toBe(bugs.items[0]!.key);
    const secondBug = (
      await runNextReady(
        { projectKey: 'PROD', lane: 'bug', excludeIds: [bugs.items[0]!.id] },
        fx.ctx,
      )
    ).structuredContent as { item: { key: string } | null };
    expect(secondBug.item?.key).toBe(bugs.items[1]!.key);

    const container = (await runNextReady({ projectKey: 'PROD', lane: 'container' }, fx.ctx))
      .structuredContent as { item: unknown; container: { key: string; readyLeafCount: number } };
    expect(container.item).toBeNull();
    expect(container.container).toMatchObject({ key: t.S.identifier, readyLeafCount: 2 });
  });

  it('refuses an unknown lane, naming the three, and returns nothing', async () => {
    const fx = await makeWorkItemFixture();
    await laneTree(fx);
    const client = await connectClient(fx.ctx);
    for (const name of ['list_ready', 'next_ready']) {
      const res = await client.callTool({ name, arguments: { projectKey: 'PROD', lane: 'epic' } });
      expect(res.isError).toBe(true);
      const text = JSON.stringify(res.content);
      for (const lane of ['leaf', 'container', 'bug']) expect(text).toContain(lane);
      expect(res.structuredContent).toBeUndefined();
    }
    await client.close();
  });
});
