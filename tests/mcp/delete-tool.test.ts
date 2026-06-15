import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runDeleteWorkItem } from '@/lib/mcp/tools/deleteWorkItem';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP `delete_work_item` (Subtask 2.8.5) over real Postgres. The tool is a thin
// adapter over the shipped 2.8.2 `deleteWorkItem` service, so we assert: a delete
// made via the client round-trip removes the item AND its whole subtree and
// returns the cascade summary; a leaf delete reports a flat count; and the
// 404-not-403 cross-tenant contract holds. Inngest is spied so post-commit
// events never hit the network (the edit-archive-tools.test.ts pattern).

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

describe('delete_work_item', () => {
  it('permanently deletes the item + subtree and reports the cascade summary', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    // epic → story → subtask: a 3-row subtree.
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Doomed epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Child story', parentId: epic.id },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Grandchild', parentId: story.id },
      fx.ctx,
    );

    const res = await client.callTool({
      name: 'delete_work_item',
      arguments: { key: epic.identifier },
    });
    expect(res.isError).toBeFalsy();
    const summary = res.structuredContent as {
      deleted: boolean;
      identifier: string;
      totalCount: number;
      descendantCount: number;
      byKind: Record<string, number>;
    };
    expect(summary.deleted).toBe(true);
    expect(summary.identifier).toBe(epic.identifier);
    expect(summary.totalCount).toBe(3);
    expect(summary.descendantCount).toBe(2);
    expect(summary.byKind).toEqual({ story: 1, subtask: 1 });

    // The whole subtree is gone — the root and every descendant 404.
    await expect(
      workItemsService.getWorkItemByIdentifier(fx.projectId, epic.identifier, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      workItemsService.getWorkItemByIdentifier(fx.projectId, story.identifier, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);

    await client.close();
  });

  it('reports a flat count for a leaf item (no descendants)', async () => {
    const fx = await makeWorkItemFixture();
    const leaf = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Lonely task' },
      fx.ctx,
    );
    const res = await runDeleteWorkItem({ key: leaf.identifier }, fx.ctx);
    expect(res.isError).toBeFalsy();
    const summary = res.structuredContent as {
      totalCount: number;
      descendantCount: number;
      byKind: Record<string, number>;
    };
    expect(summary.totalCount).toBe(1);
    expect(summary.descendantCount).toBe(0);
    expect(summary.byKind).toEqual({});
  });

  it('is 404-not-403 across tenants (a foreign key is an indistinguishable not-found)', async () => {
    const a = await makeWorkItemFixture();
    const itemA = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'task', title: 'A item' },
      a.ctx,
    );
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const res = await runDeleteWorkItem({ key: itemA.identifier }, b.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
    // The cross-tenant delete must NOT have removed A's item.
    const stillThere = await workItemsService.getWorkItemByIdentifier(
      a.projectId,
      itemA.identifier,
      a.ctx,
    );
    expect(stillThere.id).toBe(itemA.id);
  });
});
