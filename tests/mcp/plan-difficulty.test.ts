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
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// EVERY PLAN DOOR CARRIES `difficulty` (Story MOTIR-6095 · Subtask MOTIR-6136).
//
// MOTIR-6133 taught the SERVICE the field; every MCP tool in front of it parses
// against its own zod schema, and a strict schema REFUSES a key it does not
// declare. So each door is proven by CALLING it with the key and reading the
// value back out of `get_plan` — never by the schema listing it alone.
//
// Real Postgres, the real MCP server over the in-memory transport.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-difficulty', version: '0.0.0' });
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
    title: 'A plan with difficulties',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  return struct(result).id;
}

async function readPlan(client: Client, planId: string) {
  const read = await call(client, GET_PLAN_TOOL_NAME, { planId });
  expect(read.isError).toBeFalsy();
  return { plan: struct(read), rendered: text(read) };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add_plan_items — the APPEND door carries `difficulty`', () => {
  it('accepts `trivial` on a subtask; `get_plan` returns it and renders it beside the size', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Rename the flag',
            kind: 'subtask',
            storyPoints: 1,
            estimateMinutes: 10,
            difficulty: 'trivial',
          },
        },
      ],
    });
    expect(appended.isError).toBeFalsy();

    const { plan, rendered } = await readPlan(client, planId);
    expect(plan.items[0]!.proposedFields!.difficulty).toBe('trivial');
    expect(rendered).toContain('+ [subtask] Rename the flag (1 pts · 10m · trivial)');
    await client.close();
  });

  it('renders a difficulty with no size as its own parenthetical, and none when absent', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Hard one', kind: 'task', difficulty: 'high' } },
        { op: 'add', proposedFields: { title: 'Unjudged', kind: 'task' } },
      ],
    });

    const { rendered } = await readPlan(client, planId);
    expect(rendered).toContain('+ [task] Hard one (high)');
    expect(rendered).toMatch(/\+ \[task\] Unjudged(?! \()/);
    await client.close();
  });

  it('refuses a value outside the scale AT THE SCHEMA, naming the field, and appends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Off scale', kind: 'task', difficulty: 'extreme' } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('difficulty');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('refuses a difficulty on a STORY with the typed INVALID_PROPOSAL naming the field — not dropped', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'A story', kind: 'story', difficulty: 'low' } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INVALID_PROPOSAL');
    expect(text(result)).toContain('difficulty');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('a `modify`’s patch carries `difficulty`, and `get_plan` lists it among the changed fields', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { difficulty: 'medium' } }],
    });
    expect(appended.isError).toBeFalsy();

    const { plan, rendered } = await readPlan(client, planId);
    expect(plan.items[0]!.patch).toMatchObject({ difficulty: 'medium' });
    expect(rendered).toMatch(/~ modify \S+ — difficulty/);

    const bad = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { difficulty: 'extreme' } }],
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('difficulty');
    await client.close();
  });
});

describe('update_plan_item — the DEEPEN door carries `difficulty`', () => {
  it('SETS it, leaves it on a call that omits it, and CLEARS it on `null`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Deepen me', kind: 'subtask' } }],
    });
    const planItemId = ids(appended)[0]!;

    const set = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      difficulty: 'high',
    });
    expect(set.isError).toBeFalsy();
    expect(text(set)).toContain('difficulty');
    expect((await readPlan(client, planId)).plan.items[0]!.proposedFields!.difficulty).toBe('high');

    await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, { planId, planItemId, priority: 'high' });
    expect((await readPlan(client, planId)).plan.items[0]!.proposedFields!.difficulty).toBe('high');

    const cleared = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      difficulty: null,
    });
    expect(cleared.isError).toBeFalsy();
    expect((await readPlan(client, planId)).plan.items[0]!.proposedFields!.difficulty).toBeNull();
    await client.close();
  });

  it('refuses a deepen that sets one on a container, with INVALID_PROPOSAL', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'An epic', kind: 'epic' } }],
    });

    const result = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: ids(appended)[0]!,
      difficulty: 'medium',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INVALID_PROPOSAL');
    expect(text(result)).toContain('difficulty');
    await client.close();
  });
});

describe('update_plan_proposal — the CORRECTION door carries `difficulty`', () => {
  it('sets it on an `add` and on a `modify`’s patch of a CLOSED plan; both read back', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Correct me', kind: 'task' } },
        { op: 'modify', workItemId: target.id, patch: { priority: 'low' } },
      ],
      final: true,
    });
    const [addId, modifyId] = ids(appended);

    const onAdd = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId!,
      difficulty: 'low',
    });
    expect(onAdd.isError).toBeFalsy();

    const onModify = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId!,
      patch: { priority: 'low', difficulty: 'high' },
    });
    expect(onModify.isError).toBeFalsy();

    const { plan } = await readPlan(client, planId);
    expect(plan.status).toBe('planned');
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    expect(byId.get(addId!)!.proposedFields!.difficulty).toBe('low');
    expect(byId.get(modifyId!)!.patch).toMatchObject({ difficulty: 'high' });
    await client.close();
  });
});

describe('the published schemas describe `difficulty` truthfully', () => {
  it('every authoring door declares the enum from `WORK_ITEM_DIFFICULTIES`, leaf-only and REASONING', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const schemaOf = (name: string) =>
      tools.find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, Record<string, unknown>>;
      };

    type Prop = { enum?: string[]; description?: string; anyOf?: Prop[]; type?: unknown };
    const add = schemaOf(ADD_PLAN_ITEMS_TOOL_NAME).properties['proposals'] as {
      items: { properties: Record<string, { properties: Record<string, Prop> }> };
    };
    const found: Prop[] = [
      add.items.properties['proposedFields']!.properties['difficulty']!,
      add.items.properties['patch']!.properties['difficulty']!,
      schemaOf(UPDATE_PLAN_ITEM_TOOL_NAME).properties['difficulty'] as Prop,
      schemaOf(UPDATE_PLAN_PROPOSAL_TOOL_NAME).properties['difficulty'] as Prop,
    ];
    for (const prop of found) {
      expect(prop).toBeDefined();
      const members = prop.enum ?? prop.anyOf?.find((p) => p.enum)?.enum;
      expect(members).toEqual([...WORK_ITEM_DIFFICULTIES]);
      expect(prop.description).toContain('REASON');
      expect(prop.description).toContain('INVALID_PROPOSAL');
      expect(prop.description).toMatch(/Leaf kinds only/);
    }
    await client.close();
  });
});
