import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { TODO_TEXT_MAX_LENGTH } from '@/lib/workItemTodos/limits';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// EVERY DOOR CARRIES `todos` (Story MOTIR-3810 · Subtask MOTIR-4619).
//
// The carrier (MOTIR-4616) taught the SERVICE the field. Every parser in front
// of it picks its keys BY NAME, so a door that does not list `todos` does not
// refuse it — it answers `200` and stores a proposal with no steps. That is the
// defect this suite exists to pin, and it is why the assertions read the field
// back out of the plan rather than trusting the call's own success.
//
// Real Postgres, the real MCP server over the in-memory transport.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

const FOUR_STEPS = [
  { text: 'Create a restricted API key' },
  { text: 'Scope it to charges:write', notesMd: 'Dashboard → Developers → API keys.' },
  {
    text: 'Set the deployment secret',
    commandText: 'fly secrets set STRIPE_KEY=… -a motir',
    executor: 'coding_agent',
  },
  { text: 'Confirm a test charge succeeds' },
];

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'proposed-todos', version: '0.0.0' });
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

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const result = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A plan with steps',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  return struct(result).id;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add_plan_items — the APPEND door carries `todos`', () => {
  it('persists the rows verbatim, and `get_plan` prints `· 4 steps` and returns them', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Provision the Stripe key',
            kind: 'task',
            type: 'manual',
            executor: 'human',
            todos: FOUR_STEPS,
          },
        },
      ],
    });

    const read = await call(client, GET_PLAN_TOOL_NAME, { planId });
    // `structuredContent` carries the rows without a second call — the reason
    // the one-line render can afford to be only a count.
    expect(struct(read).items[0]!.proposedFields!.todos).toEqual(FOUR_STEPS);
    // …and the count is on the line a reviewer scans.
    expect(text(read)).toContain('· 4 steps');
    await client.close();
  });

  it('prints no step marker for an add with no steps, and the singular for one', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'A bare card', kind: 'task' } },
        {
          op: 'add',
          proposedFields: { title: 'One step', kind: 'task', todos: [{ text: 'The one thing' }] },
        },
      ],
    });

    const rendered = text(await call(client, GET_PLAN_TOOL_NAME, { planId }));
    expect(rendered).toContain('· 1 step');
    expect(rendered).not.toContain('· 1 steps');
    // The add with none renders its line without any step marker at all.
    const bareLine = rendered.split('\n').find((l) => l.includes('A bare card'))!;
    expect(bareLine).not.toContain('step');
    await client.close();
  });

  it('refuses a step past the granularity bar, with the service’s own message', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'A two-operation step',
            kind: 'task',
            todos: [{ text: 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1) }],
          },
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Split it into two steps');
    // The refusal names the ROW, which is what an agent needs to act on.
    expect(text(result)).toContain('step 1');
    await client.close();
  });

  it('refuses a non-empty list on a CONTAINER kind', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A story', kind: 'story', todos: [{ text: 'A step' }] },
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('container');
    await client.close();
  });
});

describe('update_plan_item — the DEEPEN door carries `todos`', () => {
  it('REPLACES the list, and `[]` / `null` clear it while omitting leaves it', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Deepen me', kind: 'task' } }],
    });
    const planItemId = ids(appended)[0]!;

    // The deepen SETS the list on a skeleton proposal — the titles-first shape
    // this door exists for.
    const set = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      type: 'manual',
      executor: 'human',
      todos: FOUR_STEPS,
    });
    expect(struct(set).items[0]!.proposedFields!.todos).toHaveLength(4);
    expect(text(set)).toContain('todos');

    // A second call naming another field leaves the list alone.
    const untouched = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      priority: 'high',
    });
    expect(untouched.structuredContent).toBeDefined();
    expect(struct(untouched).items[0]!.proposedFields!.todos).toHaveLength(4);

    // A new array REPLACES the set whole — there is no per-row merge.
    const replaced = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      todos: [{ text: 'The only step now' }],
    });
    expect(struct(replaced).items[0]!.proposedFields!.todos).toEqual([
      { text: 'The only step now' },
    ]);

    // `[]` empties it; `null` clears it.
    const emptied = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      todos: [],
    });
    expect(struct(emptied).items[0]!.proposedFields!.todos).toEqual([]);
    const cleared = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      todos: null,
    });
    expect(struct(cleared).items[0]!.proposedFields!.todos).toBeNull();
    await client.close();
  });

  it('refuses a deepen that turns a leaf carrying steps into a container', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A leaf with steps', kind: 'task', todos: [{ text: 'A step' }] },
        },
      ],
    });

    // The PATCH names only `kind` and is innocent on its own; the MERGE is what
    // is illegal, which is why the gate reads the merge.
    const result = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: ids(appended)[0]!,
      kind: 'story',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('container');
    await client.close();
  });
});

describe('update_plan_proposal — the CORRECTION door carries `todos`', () => {
  it('replaces the list on a plan that has already CLOSED', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Correct my steps', kind: 'task', todos: [{ text: 'Wrong' }] },
        },
      ],
      final: true,
    });

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: ids(appended)[0]!,
      todos: [{ text: 'Right', executor: 'human' }],
    });

    expect(struct(corrected).status).toBe('planned');
    expect(struct(corrected).items[0]!.proposedFields!.todos).toEqual([
      { text: 'Right', executor: 'human' },
    ]);
    await client.close();
  });

  it('a `modify`’s patch carries NO steps — a plan does not edit a person’s progress', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    // The patch schema declares no `todos`, and the service's `applyModify`
    // writes only `PLAN_ITEM_PATCH_KEYS`, so a key sent here reaches no column:
    // the target's list is untouched by a plan (AMENDMENT 14 D2).
    const target = await createTestWorkItem(fx, { title: 'A committed card', kind: 'task' });
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { title: 'A re-scoped title', todos: [{ text: 'Should not land' }] },
        },
      ],
    });

    const stored = struct(appended).items[0]!.patch as Record<string, unknown>;
    expect(stored.title).toBe('A re-scoped title');
    // Nothing anywhere turns this into a to-do row.
    expect(await adminDb.workItemTodo.count()).toBe(0);
    await client.close();
  });
});
