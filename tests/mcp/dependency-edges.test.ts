import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { edgeMarker } from '@/lib/mcp/dependencyEdges';
import { CrossWorkspaceLinkError } from '@/lib/workItems/linkErrors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// The dependency-EDGE projection for the MCP LIST reads (Subtask 7.9.0f /
// MOTIR-1842) over real Postgres. Three layers, one contract:
//
//   repository — `findBlockedEdgesForItems`, the REVERSE-direction sibling of
//     `findBlockerEdgesForItems`: one query, archived far ends excluded, empty
//     input short-circuits WITHOUT a query, workspace-scoped.
//   service    — `getDependencyEdgesForItems`, both directions keyed by item id,
//     TOTAL (empty arrays, never a missing key), and — the load-bearing claim —
//     TWO queries for a page of ANY size. Asserted by spying on the Prisma
//     delegate itself, so the count is real queries, not repository calls.
//   transport  — `list_ready` + `search_work_items` attach the IDENTICAL
//     `dependencies` block to every structuredContent row and render the same
//     compact marker in the text block.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

const mk = (fx: WorkItemFixture, title: string, projectId?: string) =>
  workItemsService.createWorkItem(
    { projectId: projectId ?? fx.projectId, kind: 'task', title },
    fx.ctx,
  );

const block = (fx: WorkItemFixture, blockedId: string, blockerId: string) =>
  workItemsService.linkWorkItems(
    { fromId: blockedId, toId: blockerId, kind: 'is_blocked_by' },
    fx.ctx,
  );

const archive = (id: string) =>
  db.workItem.update({ where: { id }, data: { archivedAt: new Date() } });

const markDone = (id: string) => db.workItem.update({ where: { id }, data: { status: 'done' } });

/** Count REAL `work_item_link` queries issued while `run` executes. */
async function countLinkQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const spy = vi.spyOn(db.workItemLink, 'findMany');
  const result = await run();
  const queries = spy.mock.calls.length;
  spy.mockRestore();
  return { result, queries };
}

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dependency-edges', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

type Row = { id: string; dependencies: { blockedBy: unknown[]; blocks: unknown[] } };
const rows = (r: CallToolResult) => (r.structuredContent as { items: Row[] }).items;
const textOf = (r: CallToolResult) => JSON.stringify(r.content);

describe('workItemLinkRepository.findBlockedEdgesForItems — the reverse edge read', () => {
  it('short-circuits on an empty id set WITHOUT issuing a query', async () => {
    const { result, queries } = await countLinkQueries(() =>
      workItemLinkRepository.findBlockedEdgesForItems([]),
    );
    expect(result).toEqual([]);
    expect(queries).toBe(0);
  });

  it('returns what each item BLOCKS — key, title, status — in ONE query', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const dependentA = await mk(fx, 'Wire the UI');
    const dependentB = await mk(fx, 'Wire the API');
    await block(fx, dependentA.id, blocker.id);
    await block(fx, dependentB.id, blocker.id);

    const { result, queries } = await countLinkQueries(() =>
      workItemLinkRepository.findBlockedEdgesForItems([blocker.id]),
    );
    expect(queries).toBe(1);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.blockedKey).sort()).toEqual(
      [dependentA.identifier, dependentB.identifier].sort(),
    );
    const a = result.find((r) => r.blockedId === dependentA.id)!;
    expect(a).toMatchObject({
      toId: blocker.id,
      blockedKey: dependentA.identifier,
      blockedTitle: 'Wire the UI',
      blockedStatus: 'todo',
      blockedProjectId: fx.projectId,
    });
  });

  it('EXCLUDES an archived item on the far end (the MOTIR-1328 rule, mirrored)', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const live = await mk(fx, 'Live dependent');
    const gone = await mk(fx, 'Archived dependent');
    await block(fx, live.id, blocker.id);
    await block(fx, gone.id, blocker.id);
    await archive(gone.id);

    const edges = await workItemLinkRepository.findBlockedEdgesForItems([blocker.id]);
    expect(edges.map((e) => e.blockedId)).toEqual([live.id]);
  });

  it('scopes to the given workspace — another tenant’s id yields nothing', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const blocker = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    expect(
      await workItemLinkRepository.findBlockedEdgesForItems([blocker.id], fx.workspaceId),
    ).toHaveLength(1);
    expect(
      await workItemLinkRepository.findBlockedEdgesForItems([blocker.id], other.workspaceId),
    ).toEqual([]);
  });

  it('its forward sibling carries the blocker’s TITLE for the same projection', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    const edges = await workItemLinkRepository.findBlockerEdgesForItems(
      [dependent.id],
      fx.workspaceId,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromId: dependent.id,
      blockerKey: blocker.identifier,
      blockerTitle: 'Ship the schema',
      blockerStatus: 'todo',
    });
  });
});

describe('workItemsService.getDependencyEdgesForItems — the page projection', () => {
  it('returns BOTH directions keyed by item id', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const middle = await mk(fx, 'Wire the service');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, middle.id, blocker.id);
    await block(fx, dependent.id, middle.id);

    const edges = await workItemsService.getDependencyEdgesForItems(
      [blocker.id, middle.id, dependent.id],
      fx.ctx,
    );
    expect(edges[middle.id]).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'todo' }],
      blocks: [{ key: dependent.identifier, title: 'Wire the UI', status: 'todo' }],
    });
    expect(edges[blocker.id]!.blockedBy).toEqual([]);
    expect(edges[dependent.id]!.blocks).toEqual([]);
  });

  it('is TOTAL — an edge-free item carries empty arrays, never a missing key', async () => {
    const fx = await makeWorkItemFixture();
    const lonely = await mk(fx, 'No edges at all');

    const edges = await workItemsService.getDependencyEdgesForItems([lonely.id], fx.ctx);
    expect(Object.keys(edges)).toEqual([lonely.id]);
    expect(edges[lonely.id]).toEqual({ blockedBy: [], blocks: [] });
  });

  it('short-circuits an empty page to {} without a query', async () => {
    const fx = await makeWorkItemFixture();
    const { result, queries } = await countLinkQueries(() =>
      workItemsService.getDependencyEdgesForItems([], fx.ctx),
    );
    expect(result).toEqual({});
    expect(queries).toBe(0);
  });

  it('issues at most TWO queries for a 24-item page with edges in both directions', async () => {
    const fx = await makeWorkItemFixture();
    const items: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 24; i++) items.push(await mk(fx, `Item ${i}`));
    // A chain: every item blocks its successor, so every interior item has an
    // edge in BOTH directions — the worst case for an N+1.
    for (let i = 1; i < items.length; i++) await block(fx, items[i]!.id, items[i - 1]!.id);

    const { result, queries } = await countLinkQueries(() =>
      workItemsService.getDependencyEdgesForItems(
        items.map((i) => i.id),
        fx.ctx,
      ),
    );
    expect(queries).toBe(2);
    expect(Object.keys(result)).toHaveLength(24);
    expect(result[items[12]!.id]).toEqual({
      blockedBy: [{ key: items[11]!.identifier, title: 'Item 11', status: 'todo' }],
      blocks: [{ key: items[13]!.identifier, title: 'Item 13', status: 'todo' }],
    });
  });

  it('resolves an edge to another PROJECT in the same workspace', async () => {
    const fx = await makeWorkItemFixture();
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PLAT',
    });
    const here = await mk(fx, 'Depends on the platform');
    const there = await mk(fx, 'Platform primitive', otherProject.id);
    await block(fx, here.id, there.id);

    const edges = await workItemsService.getDependencyEdgesForItems([here.id], fx.ctx);
    expect(edges[here.id]!.blockedBy).toEqual([
      { key: there.identifier, title: 'Platform primitive', status: 'todo' },
    ]);
    // The far end really is in the OTHER project — the edge crossed a project
    // boundary, which `link_work_items` allows inside one workspace.
    expect(there.projectId).toBe(otherProject.id);
    expect(there.projectId).not.toBe(here.projectId);
  });

  it('never returns a far end from another TENANT (the link itself is rejected)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const here = await mk(fx, 'Ours');
    const theirs = await mk(other, 'Theirs');

    await expect(block(fx, here.id, theirs.id)).rejects.toBeInstanceOf(CrossWorkspaceLinkError);
    // …and reading the other tenant's item through OUR context yields nothing.
    const edges = await workItemsService.getDependencyEdgesForItems([here.id, theirs.id], fx.ctx);
    expect(edges[here.id]).toEqual({ blockedBy: [], blocks: [] });
    expect(edges[theirs.id]).toEqual({ blockedBy: [], blocks: [] });
  });

  it('orders each direction by key, numeric-aware (PROD-9 before PROD-10)', async () => {
    const fx = await makeWorkItemFixture();
    const hub = await mk(fx, 'Hub');
    const made: Awaited<ReturnType<typeof mk>>[] = [];
    // Create enough items that the identifiers cross the 9 → 10 boundary.
    for (let i = 0; i < 12; i++) made.push(await mk(fx, `Dep ${i}`));
    // Link in REVERSE creation order so insertion order can't be what sorts them.
    for (const item of [...made].reverse()) await block(fx, item.id, hub.id);

    const edges = await workItemsService.getDependencyEdgesForItems([hub.id], fx.ctx);
    const keys = edges[hub.id]!.blocks.map((e) => e.key);
    expect(keys).toEqual(made.map((m) => m.identifier));
  });
});

describe('the `dependencies` block on the MCP list reads', () => {
  it('list_ready rows carry the block; a ready item shows what it BLOCKS', async () => {
    const fx = await makeWorkItemFixture();
    const ready = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, ready.id);

    const res = await runListReady({ projectKey: 'PROD' }, fx.ctx);
    const items = rows(res);
    // `dependent` is blocked, so only `ready` is in the ready set.
    expect(items).toHaveLength(1);
    expect(items[0]!.dependencies).toEqual({
      blockedBy: [],
      blocks: [{ key: dependent.identifier, title: 'Wire the UI', status: 'todo' }],
    });
    expect(textOf(res)).toContain(`blocks ${dependent.identifier}`);
  });

  it('list_ready shows a satisfied blocker in blockedBy (a done blocker keeps it ready)', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const item = await mk(fx, 'Wire the UI');
    await block(fx, item.id, blocker.id);
    await markDone(blocker.id);

    const items = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx));
    const row = items.find((r) => r.id === item.id)!;
    expect(row.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'done' }],
      blocks: [],
    });
  });

  it('an edge-free row still carries both arrays, and its text line is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    await mk(fx, 'All alone');

    const res = await runListReady({ projectKey: 'PROD' }, fx.ctx);
    expect(rows(res)[0]!.dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(textOf(res)).not.toContain('blocked by');
    expect(textOf(res)).not.toContain('blocks ');
  });

  it('search_work_items carries the IDENTICAL block for the same item', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const middle = await mk(fx, 'Wire the service');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, middle.id, blocker.id);
    await block(fx, dependent.id, middle.id);
    await markDone(blocker.id);

    const readyRow = rows(await runListReady({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === middle.id,
    )!;
    const searchRow = rows(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx)).find(
      (r) => r.id === middle.id,
    )!;
    expect(searchRow.dependencies).toEqual(readyRow.dependencies);
    expect(searchRow.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'done' }],
      blocks: [{ key: dependent.identifier, title: 'Wire the UI', status: 'todo' }],
    });
  });

  it('search_work_items renders both directions in its text block', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const middle = await mk(fx, 'Wire the service');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, middle.id, blocker.id);
    await block(fx, dependent.id, middle.id);

    const text = textOf(await runSearchWorkItems({ projectKey: 'PROD' }, fx.ctx));
    expect(text).toContain(`blocked by ${blocker.identifier} · blocks ${dependent.identifier}`);
  });

  it('both tools advertise the block, and it survives the real transport', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await mk(fx, 'Ship the schema');
    const dependent = await mk(fx, 'Wire the UI');
    await block(fx, dependent.id, blocker.id);

    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    for (const name of ['list_ready', 'search_work_items']) {
      expect(tools.find((t) => t.name === name)!.description).toContain('dependencies');
    }
    const res = (await client.callTool({
      name: 'search_work_items',
      arguments: { projectKey: 'PROD' },
    })) as CallToolResult;
    const row = rows(res).find((r) => r.id === dependent.id)!;
    expect(row.dependencies).toEqual({
      blockedBy: [{ key: blocker.identifier, title: 'Ship the schema', status: 'todo' }],
      blocks: [],
    });
    await client.close();
  });
});

describe('edgeMarker', () => {
  it('renders nothing for an absent projection or an edge-free item', () => {
    expect(edgeMarker(undefined)).toBe('');
    expect(edgeMarker({ blockedBy: [], blocks: [] })).toBe('');
  });

  it('renders each direction that has edges', () => {
    const e = { key: 'PROD-3', title: 'x', status: 'todo' };
    expect(edgeMarker({ blockedBy: [e], blocks: [] })).toBe(' · blocked by PROD-3');
    expect(edgeMarker({ blockedBy: [], blocks: [e] })).toBe(' · blocks PROD-3');
    expect(edgeMarker({ blockedBy: [e], blocks: [{ ...e, key: 'PROD-9' }] })).toBe(
      ' · blocked by PROD-3 · blocks PROD-9',
    );
  });
});
