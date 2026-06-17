import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runMoveToParent } from '@/lib/mcp/tools/moveToParent';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP re-parent tool (bug MOTIR-1017) over real Postgres. `move_to_parent` is a
// thin adapter over `workItemsService.moveWorkItem` — the SAME re-parent path
// the tree/board UI uses. We assert: a move made via the client round-trip reads
// back through get_work_item (and mints a valid position in the new parent);
// promotion to a top-level root; the kind-parent matrix, the orphan-subtask
// rule, and the 4-level depth trigger surface as typed errors; a same-parent
// move is an idempotent no-op; and the 404-not-403 cross-tenant contract on both
// the moved item and the parent. Inngest is spied so post-commit events never
// hit the network (the edit-archive-tools.test.ts pattern).

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

/** Create a work item of `kind` under `parentId` (null → top-level root). */
function make(
  ctx: ServiceContext,
  projectId: string,
  kind: WorkItemKindDto,
  title: string,
  parentId: string | null = null,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind, title, parentId }, ctx);
}

describe('move_to_parent', () => {
  it('re-parents under a new parent; the change reads back through get_work_item and keeps identity', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const epicA = await make(fx.ctx, fx.projectId, 'epic', 'Epic A');
    const epicB = await make(fx.ctx, fx.projectId, 'epic', 'Epic B');
    const story = await make(fx.ctx, fx.projectId, 'story', 'Movable story', epicA.id);
    expect(story.parentId).toBe(epicA.id);

    const res = await client.callTool({
      name: 'move_to_parent',
      arguments: { key: story.identifier, parentKey: epicB.identifier },
    });
    expect(res.isError).toBeFalsy();
    const moved = res.structuredContent as unknown as WorkItemDto;
    expect(moved.parentId).toBe(epicB.id);
    // Same identifier — the move preserves identity (the whole point vs recreate).
    expect(moved.identifier).toBe(story.identifier);
    // A valid fractional position was minted into the new sibling set.
    expect(typeof moved.position).toBe('string');
    expect(moved.position.length).toBeGreaterThan(0);

    const got = await client.callTool({
      name: 'get_work_item',
      arguments: { key: story.identifier },
    });
    expect((got.structuredContent as { item: WorkItemDto }).item.parentId).toBe(epicB.id);

    await client.close();
  });

  it('promotes an item to a top-level root when parentKey is null', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await make(fx.ctx, fx.projectId, 'epic', 'Epic');
    const story = await make(fx.ctx, fx.projectId, 'story', 'Story', epic.id);

    const res = await runMoveToParent({ key: story.identifier, parentKey: null }, fx.ctx);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as unknown as WorkItemDto).parentId).toBeNull();
  });

  it('a same-parent move is an idempotent no-op (no error)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await make(fx.ctx, fx.projectId, 'epic', 'Epic');
    const story = await make(fx.ctx, fx.projectId, 'story', 'Story', epic.id);

    const res = await runMoveToParent(
      { key: story.identifier, parentKey: epic.identifier },
      fx.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as unknown as WorkItemDto).parentId).toBe(epic.id);
  });

  it('rejects a kind-illegal parent (epic under a story) with a typed error', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx.ctx, fx.projectId, 'story', 'Story');
    const epic = await make(fx.ctx, fx.projectId, 'epic', 'Epic');
    const res = await runMoveToParent(
      { key: epic.identifier, parentKey: story.identifier },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });

  it('rejects promoting a subtask to the top level (it must have a parent)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx.ctx, fx.projectId, 'story', 'Story');
    const subtask = await make(fx.ctx, fx.projectId, 'subtask', 'Sub', story.id);
    const res = await runMoveToParent({ key: subtask.identifier, parentKey: null }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });

  it('rejects a move that would exceed the 4-level depth limit', async () => {
    const fx = await makeWorkItemFixture();
    // A kind-legal depth-4 chain: epic → story → task → bug.
    const epic = await make(fx.ctx, fx.projectId, 'epic', 'L1 epic');
    const story = await make(fx.ctx, fx.projectId, 'story', 'L2 story', epic.id);
    const task = await make(fx.ctx, fx.projectId, 'task', 'L3 task', story.id);
    const bug = await make(fx.ctx, fx.projectId, 'bug', 'L4 bug', task.id);
    // A subtask living shallow elsewhere; moving it under the L4 bug → L5.
    const otherStory = await make(fx.ctx, fx.projectId, 'story', 'Other story');
    const subtask = await make(fx.ctx, fx.projectId, 'subtask', 'Deep sub', otherStory.id);

    const res = await runMoveToParent(
      { key: subtask.identifier, parentKey: bug.identifier },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('DEPTH_LIMIT_EXCEEDED');
  });

  it('is 404-not-403 across tenants on the moved item', async () => {
    const a = await makeWorkItemFixture();
    const itemA = await make(a.ctx, a.projectId, 'task', 'A task');
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const parentB = await make(b.ctx, b.projectId, 'epic', 'B epic');
    const res = await runMoveToParent(
      { key: itemA.identifier, parentKey: parentB.identifier },
      b.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
  });

  it('is 404-not-403 when the parentKey is unknown / in another project', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx.ctx, fx.projectId, 'story', 'Story');
    // A foreign-project parent identifier resolves within THIS project → an
    // indistinguishable not-found (no existence leak), mirroring create_work_item.
    const res = await runMoveToParent({ key: story.identifier, parentKey: 'OTHER-1' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('WORK_ITEM_NOT_FOUND');
  });
});
