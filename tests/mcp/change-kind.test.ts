import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto, WorkItemKindDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runChangeKind } from '@/lib/mcp/tools/changeKind';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// MCP reclassify tool (MOTIR-1020) over real Postgres. `change_kind` is a thin
// adapter over `workItemsService.updateWorkItem({ kind })` — the same path the
// UI edit form uses. We assert: a kind change made via the client round-trip
// reads back through get_work_item (identity preserved); the kind-parent matrix
// is enforced against BOTH the current parent and existing children; a
// container kind cannot keep a leaf-only work type; a same-kind call is a no-op;
// and the 404-not-403 cross-tenant contract. Inngest is spied so post-commit
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

/** Create a work item of `kind` under `parentId` (null → top-level root). */
function make(
  ctx: ServiceContext,
  projectId: string,
  kind: WorkItemKindDto,
  title: string,
  parentId: string | null = null,
  type: WorkItemTypeDto | null = null,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId, kind, title, parentId, ...(type ? { type } : {}) },
    ctx,
  );
}

describe('change_kind', () => {
  it('reclassifies a work item; the change reads back through get_work_item and keeps identity', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    // A top-level task → reclassify to a bug (both are legal at the top level).
    const item = await make(fx.ctx, fx.projectId, 'task', 'Mis-typed');

    const res = await client.callTool({
      name: 'change_kind',
      arguments: { key: item.identifier, kind: 'bug' },
    });
    expect(res.isError).toBeFalsy();
    const reclassified = res.structuredContent as unknown as WorkItemDto;
    expect(reclassified.kind).toBe('bug');
    expect(reclassified.identifier).toBe(item.identifier); // identity preserved

    const got = await client.callTool({
      name: 'get_work_item',
      arguments: { key: item.identifier },
    });
    expect((got.structuredContent as { item: WorkItemDto }).item.kind).toBe('bug');

    await client.close();
  });

  it('a same-kind call is an idempotent no-op (no error)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await make(fx.ctx, fx.projectId, 'task', 'Already a task');
    const res = await runChangeKind({ key: item.identifier, kind: 'task' }, fx.ctx);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as unknown as WorkItemDto).kind).toBe('task');
  });

  it('rejects a kind illegal under the current parent', async () => {
    const fx = await makeWorkItemFixture();
    // story under epic; reclassifying the story to a subtask is legal under the
    // epic? No — a subtask may not be parented to an epic, so it is rejected.
    const epic = await make(fx.ctx, fx.projectId, 'epic', 'Epic');
    const story = await make(fx.ctx, fx.projectId, 'story', 'Story', epic.id);
    const res = await runChangeKind({ key: story.identifier, kind: 'subtask' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });

  it('rejects a kind that cannot legally parent an existing child', async () => {
    const fx = await makeWorkItemFixture();
    // A top-level story with a task child. Reclassifying the story → bug would
    // leave a bug parenting a task, which the matrix forbids (bug → subtask only).
    const story = await make(fx.ctx, fx.projectId, 'story', 'Parent story');
    await make(fx.ctx, fx.projectId, 'task', 'Child task', story.id);
    const res = await runChangeKind({ key: story.identifier, kind: 'bug' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ILLEGAL_PARENT_TYPE');
  });

  it('rejects turning a typed leaf into a container kind without clearing its work type', async () => {
    const fx = await makeWorkItemFixture();
    // A top-level task carrying a work type. Reclassifying to a story (a
    // container kind) would orphan the leaf-only type → rejected.
    const typedTask = await make(fx.ctx, fx.projectId, 'task', 'Typed task', null, 'code');
    expect(typedTask.type).toBe('code');
    const res = await runChangeKind({ key: typedTask.identifier, kind: 'story' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('TYPE_NOT_ALLOWED_ON_KIND');
  });

  it('is 404-not-403 across tenants', async () => {
    const a = await makeWorkItemFixture();
    const itemA = await make(a.ctx, a.projectId, 'task', 'A task');
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const res = await runChangeKind({ key: itemA.identifier, kind: 'bug' }, b.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
  });
});
