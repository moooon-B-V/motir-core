import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { backlogService } from '@/lib/services/backlogService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { buildMcpServer } from '@/lib/mcp/registry';
import { runCreateSprint } from '@/lib/mcp/tools/createSprint';
import { runUpdateSprint } from '@/lib/mcp/tools/updateSprint';
import { runMoveToSprint } from '@/lib/mcp/tools/moveToSprint';
import { runListSprints } from '@/lib/mcp/tools/listSprints';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import type { SprintDto } from '@/lib/dto/sprints';
import { truncateAuthTables } from '../helpers/db';

// MCP sprint tools (Subtask 7.8.10) over real Postgres. The eight tools — list /
// create / update / delete sprint, move to sprint / backlog, start / complete —
// are each a thin adapter over the shipped-and-done Epic-4 services
// (`sprintsService`, `backlogService`). We assert: the full lifecycle through
// the MCP CLIENT round-trip (create → scope via bulk move → start → complete
// with the disposition), that the typed service errors surface as tool errors
// (a completed-sprint edit, a cross-project move), that `complete_sprint`
// requires the disposition at the schema level, and the 404-not-403 cross-tenant
// contract.
//
// The server is built with a fixed-context resolver (the bearer auth gate is
// tested in auth.test.ts), so these exercise the tool surface directly. The
// fixture owner is the workspace owner, so the owner-gated sprint-management
// tools pass.

beforeEach(async () => {
  await truncateAuthTables();
  // Keep the suite hermetic: the status transition + create fire best-effort
  // post-commit job events; no-op them so nothing reaches the network.
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

describe('tools/list', () => {
  it('exposes all eight sprint tools with schemas', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      'list_sprints',
      'create_sprint',
      'update_sprint',
      'delete_sprint',
      'move_to_sprint',
      'move_to_backlog',
      'start_sprint',
      'complete_sprint',
    ]) {
      expect(names).toContain(name);
    }
    // Each carries an input schema (the SDK exposes it as inputSchema).
    const create = tools.find((t) => t.name === 'create_sprint')!;
    expect(create.inputSchema).toBeTruthy();
    await client.close();
  });
});

describe('sprint lifecycle via the MCP client', () => {
  it('create → scope (bulk move) → start → complete lands the same end state as the UI flow', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    // Two backlog items to scope into the sprint.
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Ship B' },
      fx.ctx,
    );

    // create_sprint
    const created = await client.callTool({
      name: 'create_sprint',
      arguments: { projectKey: 'PROD', name: 'Sprint A', goal: 'Ship the things' },
    });
    expect(created.isError).toBeFalsy();
    const sprint = created.structuredContent as unknown as SprintDto;
    expect(sprint.state).toBe('planned');
    expect(sprint.name).toBe('Sprint A');

    // list_sprints shows it.
    const listed = await client.callTool({
      name: 'list_sprints',
      arguments: { projectKey: 'PROD' },
    });
    const sprints = (listed.structuredContent as { sprints: SprintDto[] }).sprints;
    expect(sprints.map((s) => s.id)).toContain(sprint.id);

    // move_to_sprint (bulk).
    const moved = await client.callTool({
      name: 'move_to_sprint',
      arguments: { keys: [a.identifier, b.identifier], sprintId: sprint.id },
    });
    expect(moved.isError).toBeFalsy();
    expect((moved.structuredContent as { items: unknown[] }).items).toHaveLength(2);

    // start_sprint.
    const started = await client.callTool({
      name: 'start_sprint',
      arguments: { sprintId: sprint.id },
    });
    expect(started.isError).toBeFalsy();
    expect((started.structuredContent as unknown as SprintDto).state).toBe('active');

    // Finish A (cancelled is a done-category status), leave B unfinished.
    await workItemsService.updateStatus(a.id, 'cancelled', fx.ctx);

    // complete_sprint, carrying the unfinished items back to the backlog.
    const completed = await client.callTool({
      name: 'complete_sprint',
      arguments: { sprintId: sprint.id, carryOverTo: 'backlog' },
    });
    expect(completed.isError).toBeFalsy();
    expect((completed.structuredContent as unknown as SprintDto).state).toBe('complete');

    // The finished item stayed on the sprint; the unfinished one is in the backlog.
    const onSprint = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(onSprint.items.map((i) => i.identifier)).toEqual([a.identifier]);
    const backlog = await backlogService.getBacklog(fx.projectId, {}, fx.ctx);
    expect(backlog.items.map((i) => i.identifier)).toContain(b.identifier);

    await client.close();
  });
});

describe('typed errors surface as tool errors', () => {
  it('update_sprint on a completed sprint returns CANNOT_MODIFY_COMPLETED_SPRINT', async () => {
    const fx = await makeWorkItemFixture();
    // Drive a sprint to complete (no items, so the carry-over is a no-op).
    const create = await runCreateSprint({ projectKey: 'PROD', name: 'Done sprint' }, fx.ctx);
    const sprint = create.structuredContent as unknown as SprintDto;
    const client = await connectClient(fx.ctx);
    await client.callTool({ name: 'start_sprint', arguments: { sprintId: sprint.id } });
    await client.callTool({
      name: 'complete_sprint',
      arguments: { sprintId: sprint.id, carryOverTo: 'backlog' },
    });
    await client.close();

    const res = await runUpdateSprint({ sprintId: sprint.id, name: 'New name' }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('CANNOT_MODIFY_COMPLETED_SPRINT');
  });

  it('move_to_sprint across projects returns CROSS_PROJECT_SPRINT_ASSIGNMENT', async () => {
    const fx = await makeWorkItemFixture();
    // A second project in the SAME workspace (so the actor is a member of both).
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const otherItem = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'task', title: 'Foreign item' },
      fx.ctx,
    );
    // A sprint in project PROD; moving OTHR's item into it is cross-project.
    const create = await runCreateSprint({ projectKey: 'PROD', name: 'PROD sprint' }, fx.ctx);
    const sprint = create.structuredContent as unknown as SprintDto;

    const res = await runMoveToSprint(
      { keys: [otherItem.identifier], sprintId: sprint.id },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('CROSS_PROJECT_SPRINT_ASSIGNMENT');
  });

  it('complete_sprint REQUIRES the carryOverTo disposition (schema-level)', async () => {
    const fx = await makeWorkItemFixture();
    const create = await runCreateSprint({ projectKey: 'PROD', name: 'S' }, fx.ctx);
    const sprint = create.structuredContent as unknown as SprintDto;
    const client = await connectClient(fx.ctx);
    await client.callTool({ name: 'start_sprint', arguments: { sprintId: sprint.id } });

    // Omitting carryOverTo must fail validation — the schema marks it required.
    let rejected = false;
    try {
      const res = await client.callTool({
        name: 'complete_sprint',
        arguments: { sprintId: sprint.id },
      });
      if (res.isError) rejected = true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    await client.close();
  });
});

describe('cross-tenant — sprint tools are 404-not-403', () => {
  it('a non-member context cannot list / create / move in another tenant', async () => {
    const a = await makeWorkItemFixture();
    const aSprint = await runCreateSprint({ projectKey: 'PROD', name: 'A sprint' }, a.ctx);
    const sprintId = (aSprint.structuredContent as unknown as SprintDto).id;
    // An independent tenant whose context probes tenant A.
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });

    const list = await runListSprints({ projectKey: 'PROD' }, b.ctx);
    expect(list.isError).toBe(true);
    expect(JSON.stringify(list.content)).toContain('PROJECT_NOT_FOUND');

    const create = await runCreateSprint({ projectKey: 'PROD', name: 'sneaky' }, b.ctx);
    expect(create.isError).toBe(true);
    expect(JSON.stringify(create.content)).toContain('PROJECT_NOT_FOUND');

    // A sprint-id-addressed tool: tenant B sees tenant A's sprint as not-found.
    const update = await runUpdateSprint({ sprintId, name: 'hijack' }, b.ctx);
    expect(update.isError).toBe(true);
    expect(JSON.stringify(update.content)).toContain('SPRINT_NOT_FOUND');
  });
});
