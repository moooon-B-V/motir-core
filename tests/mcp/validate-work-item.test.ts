import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemValidityDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// `validate_work_item` (Subtask 7.8.23) over real Postgres — the single-item
// analogue of `validate_sprint`: is a work item's whole SUBTREE finishable? We
// assert the engine (`workItemsService.validateWorkItem`) directly for the
// rule's branches — in-subtree blocker (valid) / external not-done (invalid both
// conditions) / external DONE (valid loose, invalid tight) / deep grandchild /
// done-member skip / archived blocker ignored / the typed not-found — then the
// MCP tool round-trip + summary branches through the in-memory client.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'validate-work-item', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const mk = (
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  title: string,
  kind: IssueType,
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);

const link = (fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

const markDone = (id: string) => db.workItem.update({ where: { id }, data: { status: 'done' } });

describe('workItemsService.validateWorkItem — the subtree finishability rule', () => {
  it('a childless target with no blockers is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const task = await mk(fx, 'Lonely task', 'task');
    const result = await workItemsService.validateWorkItem(fx.projectId, task.identifier, fx.ctx);
    expect(result).toEqual({ key: task.identifier, valid: true, blockers: [] });
  });

  it('a target whose blockers are all IN its SUBTREE is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const childA = await mk(fx, 'Child A', 'subtask', story.id);
    const childB = await mk(fx, 'Child B', 'subtask', story.id);
    await link(fx, childA.id, childB.id); // A blocked_by B — both inside the subtree

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('a NOT-done blocker OUTSIDE the subtree is INVALID under BOTH loose and tight', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External todo', 'task'); // out of subtree, todo
    await link(fx, child.id, external.id);

    const expected = [
      {
        item: child.identifier,
        blockedBy: external.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ];
    const loose = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(loose.valid).toBe(false);
    expect(loose.blockers).toEqual(expected);

    const tight = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(tight.valid).toBe(false);
    expect(tight.blockers).toEqual(expected);
  });

  it('a DONE blocker OUTSIDE the subtree satisfies loose but gates tight', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const externalDone = await mk(fx, 'External done', 'task');
    await markDone(externalDone.id);
    await link(fx, child.id, externalDone.id);

    const loose = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(loose.valid).toBe(true);
    expect(loose.blockers).toEqual([]);

    const tight = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(tight.valid).toBe(false);
    expect(tight.blockers).toEqual([
      {
        item: child.identifier,
        blockedBy: externalDone.identifier,
        blockerStatus: 'done',
        blockerSprintId: null,
      },
    ]);
  });

  it('a DEEP grandchild gated by out-of-subtree work surfaces at the grandchild', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const task = await mk(fx, 'Task', 'task', story.id); // story → task
    const grandchild = await mk(fx, 'Grandchild', 'subtask', task.id); // task → subtask
    const external = await mk(fx, 'External todo', 'task');
    await link(fx, grandchild.id, external.id);

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(false);
    expect(result.blockers).toEqual([
      {
        item: grandchild.identifier,
        blockedBy: external.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a DONE in-subtree member needs no check — its open external blocker no longer gates', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External todo', 'task');
    await link(fx, child.id, external.id);
    await markDone(child.id);
    await markDone(story.id); // the whole subtree is done — nothing left to finish

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
  });

  it('an ARCHIVED external blocker never gates the target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External archived', 'task');
    await link(fx, child.id, external.id);
    await db.workItem.update({ where: { id: external.id }, data: { archivedAt: new Date() } });

    const result = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(result.valid).toBe(true);
  });

  it('condition defaults to loose when omitted', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const externalDone = await mk(fx, 'External done', 'task');
    await markDone(externalDone.id);
    await link(fx, child.id, externalDone.id);

    const omitted = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    const loose = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(omitted).toEqual(loose);
    expect(omitted.valid).toBe(true);
  });

  it('an unknown key → WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.validateWorkItem(fx.projectId, 'PROD-999999', fx.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });

  it('a cross-workspace key reads as not-found (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    // A's item, validated through the OUTSIDER's context → 404, never a success.
    await expect(
      workItemsService.validateWorkItem(fx.projectId, story.identifier, outsider.ctx),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });
});

describe('validate_work_item MCP tool round-trip', () => {
  const struct = (r: CallToolResult) => r.structuredContent as unknown as WorkItemValidityDto;
  const text = (r: CallToolResult) => JSON.stringify(r.content);

  it('reports a VALID work item via the client (lowercase key resolves)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    await mk(fx, 'Child', 'subtask', story.id);
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier.toLowerCase() },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(struct(res).valid).toBe(true);
    expect(struct(res).key).toBe(story.identifier);
    expect(text(res)).toContain('is VALID');
    await client.close();
  });

  it('condition: tight reports a done out-of-subtree blocker the loose default accepts', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const externalDone = await mk(fx, 'External done', 'task');
    await markDone(externalDone.id);
    await link(fx, child.id, externalDone.id);

    const client = await connectClient(fx.ctx);
    const loose = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    expect(struct(loose).valid).toBe(true);

    const tight = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier, condition: 'tight' },
    })) as CallToolResult;
    expect(tight.isError).toBeFalsy();
    expect(struct(tight).valid).toBe(false);
    expect(struct(tight).blockers).toHaveLength(1);
    expect(text(tight)).toContain('is INVALID');
    await client.close();
  });

  it('renders an out-of-subtree blocker that sits in a SPRINT with its sprint id', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const external = await mk(fx, 'External in a sprint', 'task'); // out of subtree, todo
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    await db.workItem.update({ where: { id: external.id }, data: { sprintId: sprint.id } });
    await link(fx, child.id, external.id);

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: story.identifier },
    })) as CallToolResult;
    expect(struct(res).valid).toBe(false);
    expect(struct(res).blockers[0]).toMatchObject({
      item: child.identifier,
      blockedBy: external.identifier,
      blockerSprintId: sprint.id,
    });
    // the "sprint <id>" summary branch (vs "backlog") renders.
    expect(text(res)).toContain(`sprint ${sprint.id}`);
    await client.close();
  });

  it('surfaces WORK_ITEM_NOT_FOUND as a clean tool error for an unknown key', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: 'PROD-999999' },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('WORK_ITEM_NOT_FOUND');
    await client.close();
  });
});
