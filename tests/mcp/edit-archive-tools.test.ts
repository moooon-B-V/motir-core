import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import { runArchiveWorkItem, runUnarchiveWorkItem } from '@/lib/mcp/tools/archiveWorkItem';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP edit + soft-remove tools (Subtask 7.8.14) over real Postgres.
// `update_work_item` / `archive_work_item` / `unarchive_work_item` — thin
// adapters over the shipped work-item services. We assert: a field patch made via
// the client round-trip reads back through `get_work_item`; the leaf-only `type`
// rule and the assignee-membership check surface as typed errors; archive drops
// the item from `list_ready` and unarchive restores it; and the 404-not-403
// cross-tenant contract. Inngest is spied so post-commit events never hit the
// network (the link-tools.test.ts pattern).

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

/** Create a fresh top-level item of `kind` in the fixture's project. */
function makeItem(
  ctx: ServiceContext,
  projectId: string,
  kind: 'task' | 'epic',
  title: string,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind, title }, ctx);
}

describe('update_work_item', () => {
  it('patches a subset of fields and they read back through get_work_item', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const item = await makeItem(fx.ctx, fx.projectId, 'task', 'Original');

    const res = await client.callTool({
      name: 'update_work_item',
      arguments: {
        key: item.identifier,
        title: 'Renamed',
        priority: 'high',
        type: 'design',
        estimateMinutes: 45,
        assigneeId: fx.ownerId,
      },
    });
    expect(res.isError).toBeFalsy();
    const patched = res.structuredContent as unknown as WorkItemDto;
    expect(patched.title).toBe('Renamed');
    expect(patched.priority).toBe('high');
    expect(patched.type).toBe('design');
    expect(patched.estimateMinutes).toBe(45);
    expect(patched.assigneeId).toBe(fx.ownerId);

    // Read back through get_work_item (the detail aggregate's `item`).
    const got = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    const detailItem = (got.structuredContent as { item: WorkItemDto }).item;
    expect(detailItem.title).toBe('Renamed');
    expect(detailItem.type).toBe('design');
    expect(detailItem.estimateMinutes).toBe(45);

    await client.close();
  });

  it('clears a nullable field when passed null (descriptionMd)', async () => {
    const fx = await makeWorkItemFixture();
    const withDesc = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Has desc', descriptionMd: 'body' },
      fx.ctx,
    );
    const res = await runUpdateWorkItem({ key: withDesc.identifier, descriptionMd: null }, fx.ctx);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as unknown as WorkItemDto).descriptionMd).toBeNull();
  });

  it('rejects a non-member assignee with a typed error', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx.ctx, fx.projectId, 'task', 'T');
    const res = await runUpdateWorkItem(
      { key: item.identifier, assigneeId: '00000000-0000-0000-0000-000000000000' },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ASSIGNEE_NOT_IN_WORKSPACE');
  });

  it('rejects a type on a non-leaf (epic) with a typed error', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await makeItem(fx.ctx, fx.projectId, 'epic', 'Epic');
    const res = await runUpdateWorkItem({ key: epic.identifier, type: 'code' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TYPE_NOT_ALLOWED_ON_KIND');
  });

  it('is 404-not-403 across tenants (a foreign key is an indistinguishable not-found)', async () => {
    const a = await makeWorkItemFixture();
    const itemA = await makeItem(a.ctx, a.projectId, 'task', 'A item');
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const res = await runUpdateWorkItem({ key: itemA.identifier, title: 'x' }, b.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
  });
});

describe('archive_work_item / unarchive_work_item', () => {
  it('archive removes the item from the ready set and unarchive restores it', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const item = await makeItem(fx.ctx, fx.projectId, 'task', 'Soft-removable');

    const readyKeys = async (): Promise<string[]> => {
      const r = await client.callTool({ name: 'list_ready', arguments: { projectKey: 'PROD' } });
      return (r.structuredContent as { items: { key: string }[] }).items.map((i) => i.key);
    };

    expect(await readyKeys()).toContain(item.identifier);

    const archived = await client.callTool({
      name: 'archive_work_item',
      arguments: { key: item.identifier },
    });
    expect(archived.isError).toBeFalsy();
    expect((archived.structuredContent as unknown as WorkItemDto).archivedAt).not.toBeNull();
    expect(await readyKeys()).not.toContain(item.identifier);

    const restored = await client.callTool({
      name: 'unarchive_work_item',
      arguments: { key: item.identifier },
    });
    expect(restored.isError).toBeFalsy();
    expect((restored.structuredContent as unknown as WorkItemDto).archivedAt).toBeNull();
    expect(await readyKeys()).toContain(item.identifier);

    await client.close();
  });

  it('archive is single-item — children are left intact (no cascade)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await makeItem(fx.ctx, fx.projectId, 'epic', 'Parent epic');
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Child', parentId: epic.id },
      fx.ctx,
    );

    const res = await runArchiveWorkItem({ key: epic.identifier }, fx.ctx);
    expect(res.isError).toBeFalsy();
    // The child is untouched.
    const childDetail = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      child.identifier,
      fx.ctx,
    );
    expect(childDetail.archivedAt).toBeNull();
  });

  it('unarchive is 404-not-403 across tenants', async () => {
    const a = await makeWorkItemFixture();
    const itemA = await makeItem(a.ctx, a.projectId, 'task', 'A item');
    await runArchiveWorkItem({ key: itemA.identifier }, a.ctx);
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const res = await runUnarchiveWorkItem({ key: itemA.identifier }, b.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
  });
});
