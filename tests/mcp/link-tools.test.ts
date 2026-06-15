import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runLinkWorkItems, runUnlinkWorkItems } from '@/lib/mcp/tools/linkWorkItems';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP link tools (Subtask 7.8.13) over real Postgres. `link_work_items` /
// `unlink_work_items` — thin adapters over the Epic-2 work-item link service.
// We assert: the `is_blocked_by` edge created via the client round-trip reads
// back through `get_work_item` on BOTH endpoints and removes the blocked item
// from the ready set (`isReady` / the `list_ready` tool); the `blocks` inverse
// and the `relates_to` reciprocal; idempotency on a duplicate create and a
// repeat remove; and the typed errors for self / cycle links and the
// 404-not-403 cross-tenant contract. Inngest is spied so post-commit events
// never hit the network (the write-tools.test.ts pattern).

beforeEach(async () => {
  await truncateAuthTables();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] as string[] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx`. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Create a fresh top-level task in the fixture's project, returning its DTO. */
function makeTask(ctx: ServiceContext, projectId: string, title: string): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind: 'task', title }, ctx);
}

/** The identifiers in a `get_work_item` relationship group (e.g. `blockedBy`). */
async function relIdentifiers(
  projectId: string,
  identifier: string,
  group: 'blockedBy' | 'blocks' | 'relatesTo' | 'duplicates' | 'clones',
  ctx: ServiceContext,
): Promise<string[]> {
  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx);
  return detail[group].map((l) => l.item.identifier);
}

describe('link_work_items', () => {
  it('creates an is_blocked_by edge that reads back on both endpoints and leaves the ready set', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const a = await makeTask(fx.ctx, fx.projectId, 'A (blocked)');
    const b = await makeTask(fx.ctx, fx.projectId, 'B (blocker)');

    // A is ready before any blocker.
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);

    const res = await client.callTool({
      name: 'link_work_items',
      arguments: { fromKey: a.identifier, toKey: b.identifier, relationship: 'blocked_by' },
    });
    expect(res.isError).toBeFalsy();
    const link = res.structuredContent as { kind: string; relationship: string };
    expect(link.kind).toBe('is_blocked_by');
    expect(link.relationship).toBe('blocked_by');

    // Read-back via get_work_item on BOTH endpoints (the inverse edge renders).
    expect(await relIdentifiers(fx.projectId, a.identifier, 'blockedBy', fx.ctx)).toContain(
      b.identifier,
    );
    expect(await relIdentifiers(fx.projectId, b.identifier, 'blocks', fx.ctx)).toContain(
      a.identifier,
    );

    // The blocked item leaves the ready set — what list_ready / next_ready read.
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(false);
    const ready = await client.callTool({
      name: 'list_ready',
      arguments: { projectKey: 'PROD' },
    });
    // ReadyItemDto addresses the item by `key` (the PROD-<n> identifier).
    const readyIds = (ready.structuredContent as { items: { key: string }[] }).items.map(
      (i) => i.key,
    );
    expect(readyIds).toContain(b.identifier);
    expect(readyIds).not.toContain(a.identifier);

    await client.close();
  });

  it('"blocks" links the inverse direction (the other item becomes blocked)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A');
    const b = await makeTask(fx.ctx, fx.projectId, 'B');

    // "A blocks B" stores B is_blocked_by A → B leaves the ready set, not A.
    const res = await runLinkWorkItems(
      { fromKey: a.identifier, toKey: b.identifier, relationship: 'blocks' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await workItemsService.isReady(b.id, fx.ctx)).toBe(false);
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);
    expect(await relIdentifiers(fx.projectId, b.identifier, 'blockedBy', fx.ctx)).toContain(
      a.identifier,
    );
  });

  it('"relates_to" persists the reciprocal edge on both items', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A');
    const b = await makeTask(fx.ctx, fx.projectId, 'B');

    const res = await runLinkWorkItems(
      { fromKey: a.identifier, toKey: b.identifier, relationship: 'relates_to' },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(await relIdentifiers(fx.projectId, a.identifier, 'relatesTo', fx.ctx)).toContain(
      b.identifier,
    );
    expect(await relIdentifiers(fx.projectId, b.identifier, 'relatesTo', fx.ctx)).toContain(
      a.identifier,
    );
  });

  it('is idempotent — re-creating an existing link is a success no-op, not an error', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A');
    const b = await makeTask(fx.ctx, fx.projectId, 'B');
    const args = {
      fromKey: a.identifier,
      toKey: b.identifier,
      relationship: 'blocked_by' as const,
    };

    const first = await runLinkWorkItems(args, fx.ctx);
    expect(first.isError).toBeFalsy();
    const second = await runLinkWorkItems(args, fx.ctx);
    expect(second.isError).toBeFalsy();
    expect((second.structuredContent as { idempotent?: boolean }).idempotent).toBe(true);

    // Exactly ONE edge persisted (not a duplicate).
    expect(await relIdentifiers(fx.projectId, a.identifier, 'blockedBy', fx.ctx)).toEqual([
      b.identifier,
    ]);
  });

  it('rejects a self link and a dependency cycle with a typed error', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A');
    const b = await makeTask(fx.ctx, fx.projectId, 'B');

    const selfRes = await runLinkWorkItems(
      { fromKey: a.identifier, toKey: a.identifier, relationship: 'blocked_by' },
      fx.ctx,
    );
    expect(selfRes.isError).toBe(true);
    expect(JSON.stringify(selfRes.content)).toContain('SELF_LINK');

    // A is_blocked_by B, then B is_blocked_by A would close the cycle.
    await runLinkWorkItems(
      { fromKey: a.identifier, toKey: b.identifier, relationship: 'blocked_by' },
      fx.ctx,
    );
    const cycleRes = await runLinkWorkItems(
      { fromKey: b.identifier, toKey: a.identifier, relationship: 'blocked_by' },
      fx.ctx,
    );
    expect(cycleRes.isError).toBe(true);
    expect(JSON.stringify(cycleRes.content)).toContain('WORK_ITEM_LINK_CYCLE');
  });

  it('is 404-not-403 across tenants (a foreign item key is an indistinguishable not-found)', async () => {
    const a = await makeWorkItemFixture();
    const itemA = await makeTask(a.ctx, a.projectId, 'Tenant A item');
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const itemB = await makeTask(b.ctx, b.projectId, 'Tenant B item');

    // Tenant B's context cannot even resolve tenant A's key → not-found.
    const res = await runLinkWorkItems(
      { fromKey: itemB.identifier, toKey: itemA.identifier, relationship: 'relates_to' },
      b.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
  });
});

describe('unlink_work_items', () => {
  it('removes the link (create → read-back → remove), restoring the ready set, idempotently', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const a = await makeTask(fx.ctx, fx.projectId, 'A (blocked)');
    const b = await makeTask(fx.ctx, fx.projectId, 'B (blocker)');
    const args = {
      fromKey: a.identifier,
      toKey: b.identifier,
      relationship: 'blocked_by' as const,
    };

    await runLinkWorkItems(args, fx.ctx);
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(false);

    const removed = await client.callTool({ name: 'unlink_work_items', arguments: args });
    expect(removed.isError).toBeFalsy();
    expect((removed.structuredContent as { removed: boolean }).removed).toBe(true);

    // Edge gone on read-back; A is ready again.
    expect(await relIdentifiers(fx.projectId, a.identifier, 'blockedBy', fx.ctx)).toEqual([]);
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);

    // Removing again is an idempotent no-op (removed: false), not an error.
    const again = await runUnlinkWorkItems(args, fx.ctx);
    expect(again.isError).toBeFalsy();
    expect((again.structuredContent as { removed: boolean }).removed).toBe(false);

    await client.close();
  });

  it('ignores a link not visible to the caller workspace (by-endpoints returns false)', async () => {
    // The tool can't reach this branch (key resolution 404s a foreign item
    // first), so exercise the service guard directly: a foreign ctx holding the
    // real link endpoints must NOT remove the link — it's an indistinguishable
    // not-found that returns false, leaving the edge intact.
    const a = await makeWorkItemFixture();
    const x = await makeTask(a.ctx, a.projectId, 'X');
    const y = await makeTask(a.ctx, a.projectId, 'Y');
    await runLinkWorkItems(
      { fromKey: x.identifier, toKey: y.identifier, relationship: 'blocked_by' },
      a.ctx,
    );
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });

    const removed = await workItemsService.unlinkWorkItemsByEndpoints(
      { fromId: x.id, toId: y.id, kind: 'is_blocked_by' },
      b.ctx,
    );
    expect(removed).toBe(false);
    // The edge is still there for its real owner.
    expect(await relIdentifiers(a.projectId, x.identifier, 'blockedBy', a.ctx)).toEqual([
      y.identifier,
    ]);
  });

  it('drops the relates_to reciprocal on both items', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeTask(fx.ctx, fx.projectId, 'A');
    const b = await makeTask(fx.ctx, fx.projectId, 'B');
    const args = {
      fromKey: a.identifier,
      toKey: b.identifier,
      relationship: 'relates_to' as const,
    };

    await runLinkWorkItems(args, fx.ctx);
    const res = await runUnlinkWorkItems(args, fx.ctx);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { removed: boolean }).removed).toBe(true);
    expect(await relIdentifiers(fx.projectId, a.identifier, 'relatesTo', fx.ctx)).toEqual([]);
    expect(await relIdentifiers(fx.projectId, b.identifier, 'relatesTo', fx.ctx)).toEqual([]);
  });
});
