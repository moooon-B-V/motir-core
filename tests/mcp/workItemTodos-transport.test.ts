import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { TODO_TEXT_MAX_LENGTH } from '@/lib/workItemTodos/limits';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// Story MOTIR-6739 · MOTIR-6726 — the STORY'S INTEGRATION GATE for the three
// to-do tools. Every call goes through the assembled path an agent meets:
//
//   MCP client → transport → the registry's server (strict input + the per-token
//   PERMISSION gate) → tool → `workItemTodosService` → repository → the RLS-gated
//   `work_item_todo` table on a real Postgres.
//
// The unit tier (`workItemTodosTool.test.ts`) enters at the adapters; what it
// cannot reach is the gate, the transport and a second tenant, so those are what
// every case here is about. Each case is chosen so a bypass fails it:
//
//   - THE BROWSE-ONLY ROLE is proven able to LIST first — a refusal from a
//     member who could not see the card at all would pass the write assertions
//     and say nothing about the edit gate.
//   - THE CROSS-TENANT caller holds EVERY permission and is refused anyway, and
//     tenant A's rows are re-read unchanged — the refusal must come from the
//     workspace binding, not from the grant.
//   - THE CONCURRENT DOUBLE-TICK asserts both calls succeed, the row is ticked,
//     and NO revision was written — a tick is progress, not a structural edit.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect an in-memory MCP client to a server bound to `ctx` + this `grant`. */
async function connect(ctx: ServiceContext, grant: TokenGrant): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'todo-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function refusal(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}

interface TodoOut {
  id: string;
  text: string;
  done: boolean;
  doneAt: string | null;
}
interface ListOut {
  items: TodoOut[];
  progress: { done: number; total: number };
}
interface WriteOut {
  todo: TodoOut;
  progress: { done: number; total: number };
}

async function makeCard(fx: WorkItemFixture, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

/** A workspace member holding the project's built-in `viewer` role. */
async function viewerOf(fx: WorkItemFixture): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `viewer-${Date.now()}-${Math.round(Math.random() * 1e6)}@ex.com`,
    password: 'hunter2hunter2',
    name: 'Viewer',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'viewer',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

async function todoRows(workItemIdentifier: string) {
  const item = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: workItemIdentifier },
  });
  return adminDb.workItemTodo.findMany({
    where: { workItemId: item.id },
    orderBy: { position: 'asc' },
  });
}

async function revisionCount(workItemIdentifier: string): Promise<number> {
  const item = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: workItemIdentifier },
  });
  return adminDb.workItemRevision.count({ where: { workItemId: item.id } });
}

describe('an editor: append, tick and untick through the transport', () => {
  it('appends at the end, ticks with doneAt + progress, and unticks both away', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Provision the database');
    const client = await connect(fx.ctx, GRANTABLE_PERMISSIONS);

    const a = ok<WriteOut>(await call(client, 'add_work_item_todo', { key, text: 'Create it' }));
    const b = ok<WriteOut>(await call(client, 'add_work_item_todo', { key, text: 'Copy the URL' }));
    expect(b.progress).toEqual({ done: 0, total: 2 });

    const list = ok<ListOut>(await call(client, 'list_work_item_todos', { key }));
    expect(list.items.map((t) => t.id)).toEqual([a.todo.id, b.todo.id]);

    const ticked = ok<WriteOut>(
      await call(client, 'set_work_item_todo_done', { key, todoId: a.todo.id, done: true }),
    );
    expect(ticked.todo.done).toBe(true);
    expect(ticked.todo.doneAt).not.toBeNull();
    expect(ticked.progress).toEqual({ done: 1, total: 2 });
    const [rowA] = await todoRows(key);
    expect(rowA?.doneAt).not.toBeNull();
    expect(rowA?.doneById).toBe(fx.ownerId);

    const unticked = ok<WriteOut>(
      await call(client, 'set_work_item_todo_done', { key, todoId: a.todo.id, done: false }),
    );
    expect(unticked.todo.doneAt).toBeNull();
    expect(unticked.progress).toEqual({ done: 0, total: 2 });
    const [rowA2] = await todoRows(key);
    expect(rowA2?.doneAt).toBeNull();
    expect(rowA2?.doneById).toBeNull();
    await client.close();
  });

  it('lists a step a person edited on the item page — its cleared executor reads null', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Edited in the UI');
    const client = await connect(fx.ctx, GRANTABLE_PERMISSIONS);
    const step = ok<WriteOut>(await call(client, 'add_work_item_todo', { key, text: 'Anyone' }));
    // The item page's edit path — the tools deliberately expose no edit.
    await workItemTodosService.updateTodo(step.todo.id, { executor: null }, fx.ctx);

    const res = await call(client, 'list_work_item_todos', { key });
    const list = ok<ListOut & { items: { executor: string | null }[] }>(res);
    expect(list.items[0]?.executor).toBeNull();
    expect(JSON.stringify(res.content)).toContain('Anyone');
    await client.close();
  });

  it('text over the cap is refused with the store’s error, and no row is written', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Too long');
    const client = await connect(fx.ctx, GRANTABLE_PERMISSIONS);
    const text = refusal(
      await call(client, 'add_work_item_todo', {
        key,
        text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1),
      }),
    );
    expect(text).toContain('TODO_TEXT_TOO_LONG');
    expect(await todoRows(key)).toHaveLength(0);
    await client.close();
  });

  it('a step from a DIFFERENT card of the same project is refused, and nothing changes', async () => {
    const fx = await makeWorkItemFixture();
    const mine = await makeCard(fx, 'Mine');
    const other = await makeCard(fx, 'Other');
    const client = await connect(fx.ctx, GRANTABLE_PERMISSIONS);
    const foreign = ok<WriteOut>(
      await call(client, 'add_work_item_todo', { key: other, text: 'Theirs' }),
    );

    const text = refusal(
      await call(client, 'set_work_item_todo_done', {
        key: mine,
        todoId: foreign.todo.id,
        done: true,
      }),
    );
    expect(text).toContain('WORK_ITEM_TODO_NOT_FOUND');
    const [row] = await todoRows(other);
    expect(row?.doneAt).toBeNull();
    await client.close();
  });

  it('two CONCURRENT ticks of one step: both succeed, it is ticked once, and no revision is written', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Race');
    const setup = await connect(fx.ctx, GRANTABLE_PERMISSIONS);
    const step = ok<WriteOut>(await call(setup, 'add_work_item_todo', { key, text: 'Only step' }));
    await setup.close();
    const revisionsBefore = await revisionCount(key);

    // Two clients, two server instances — the shape of two agents, not two
    // calls queued on one connection.
    const [c1, c2] = await Promise.all([
      connect(fx.ctx, GRANTABLE_PERMISSIONS),
      connect(fx.ctx, GRANTABLE_PERMISSIONS),
    ]);
    const args = { key, todoId: step.todo.id, done: true };
    const [r1, r2] = await Promise.all([
      call(c1, 'set_work_item_todo_done', args),
      call(c2, 'set_work_item_todo_done', args),
    ]);
    const o1 = ok<WriteOut>(r1);
    const o2 = ok<WriteOut>(r2);
    expect(o1.todo.done && o2.todo.done).toBe(true);
    expect(o1.progress).toEqual({ done: 1, total: 1 });
    expect(o2.progress).toEqual({ done: 1, total: 1 });

    const rows = await todoRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doneAt).not.toBeNull();
    expect(await revisionCount(key)).toBe(revisionsBefore);
    await Promise.all([c1.close(), c2.close()]);
  });
});

describe('permissions — the same people as the item page', () => {
  it('a BROWSE-ONLY role reads the list and is refused both writes by name, changing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Read only');
    const owner = await connect(fx.ctx, GRANTABLE_PERMISSIONS);
    const step = ok<WriteOut>(await call(owner, 'add_work_item_todo', { key, text: 'Seeded' }));
    await owner.close();

    // A full grant: only the ROLE may refuse here.
    const viewer = await connect(await viewerOf(fx), GRANTABLE_PERMISSIONS);
    const list = ok<ListOut>(await call(viewer, 'list_work_item_todos', { key }));
    expect(list.items.map((t) => t.id)).toEqual([step.todo.id]);

    expect(refusal(await call(viewer, 'add_work_item_todo', { key, text: 'Sneaky' }))).toContain(
      'PROJECT_ACCESS_DENIED',
    );
    expect(
      refusal(
        await call(viewer, 'set_work_item_todo_done', { key, todoId: step.todo.id, done: true }),
      ),
    ).toContain('PROJECT_ACCESS_DENIED');

    const rows = await todoRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doneAt).toBeNull();
    await viewer.close();
  });

  it('a token WITHOUT work_item:edit is refused both writes at the gate, before the service', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Grant narrowed');
    const owner = await connect(fx.ctx, GRANTABLE_PERMISSIONS);
    const step = ok<WriteOut>(await call(owner, 'add_work_item_todo', { key, text: 'Seeded' }));
    await owner.close();

    const narrowed = await connect(fx.ctx, ['project:browse']);
    ok(await call(narrowed, 'list_work_item_todos', { key }));
    for (const [name, args] of [
      ['add_work_item_todo', { key, text: 'Nope' }],
      ['set_work_item_todo_done', { key, todoId: step.todo.id, done: true }],
    ] as const) {
      const text = refusal(await call(narrowed, name, args));
      expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(text).toContain('work_item:edit');
    }
    const rows = await todoRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doneAt).toBeNull();
    await narrowed.close();
  });

  it('a CLI-grant token (a dispatched agent) lists, appends and ticks', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeCard(fx, 'Dispatched');
    const agent = await connect(fx.ctx, CLI_TOKEN_GRANT);
    const step = ok<WriteOut>(await call(agent, 'add_work_item_todo', { key, text: 'Agent step' }));
    ok(await call(agent, 'set_work_item_todo_done', { key, todoId: step.todo.id, done: true }));
    const list = ok<ListOut>(await call(agent, 'list_work_item_todos', { key }));
    expect(list.progress).toEqual({ done: 1, total: 1 });
    await agent.close();
  });
});

describe('cross-tenant — another workspace’s card is not found, on every tool', () => {
  it('never a list, never a write, and tenant A is untouched', async () => {
    const a = await makeWorkItemFixture();
    const key = await makeCard(a, 'Tenant A card');
    const ownerA = await connect(a.ctx, GRANTABLE_PERMISSIONS);
    const step = ok<WriteOut>(await call(ownerA, 'add_work_item_todo', { key, text: 'A’s step' }));
    await ownerA.close();

    // Tenant B holds EVERY permission; only the workspace binding can refuse it.
    const b = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    const outsider = await connect(b.ctx, GRANTABLE_PERMISSIONS);
    for (const [name, args] of [
      ['list_work_item_todos', { key }],
      ['add_work_item_todo', { key, text: 'leak?' }],
      ['set_work_item_todo_done', { key, todoId: step.todo.id, done: true }],
    ] as const) {
      const text = refusal(await call(outsider, name, args));
      expect(text, `${name} must read as not-found`).toMatch(/NOT_FOUND/);
      expect(text, `${name} must not leak A's step`).not.toContain('A’s step');
    }
    // Even addressed at the caller's OWN card, A's step id is not reachable.
    const ownKey = await makeCard(b, 'Tenant B card');
    expect(
      refusal(
        await call(outsider, 'set_work_item_todo_done', {
          key: ownKey,
          todoId: step.todo.id,
          done: true,
        }),
      ),
    ).toContain('WORK_ITEM_TODO_NOT_FOUND');

    const rows = await todoRows(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.doneAt).toBeNull();
    await outsider.close();
  });
});
