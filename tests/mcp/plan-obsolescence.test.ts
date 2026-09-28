import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { PLAN_ITEM_MARK_PATCH_KEYS, type PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE MARK AND ITS EDGES ON THE PLAN DOORS (Story MOTIR-6577 · Subtask MOTIR-6631).
//
// MOTIR-6629 / 6630 / 6663 taught the SERVICE the six mark patch keys and an
// `add`'s `supersedesRefs`; this proves each MCP door in front of it carries them,
// DESCRIBES them, and resolves a work-item KEY on all five supersedes carriers
// before the service sees it — the service stores only ids and `planItem:` refs,
// so an unresolved key would be refused `dangling`. Every door is proven by
// CALLING it and reading the value back out of `get_plan`.
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
  const client = new Client({ name: 'plan-obsolescence', version: '0.0.0' });
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
    title: 'A plan that marks cards',
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

/** A committed card moved to `done` — the only kind of card a plan may mark. */
async function doneCard(fx: WorkItemFixture, title: string, kind: 'story' | 'task' = 'task') {
  const item = await createTestWorkItem(fx, { kind, title });
  await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
  return item;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the schemas DECLARE the mark keys and describe their direction', () => {
  it('add_plan_items / update_plan_proposal list the six patch keys and `supersedesRefs`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === ADD_PLAN_ITEMS_TOOL_NAME)!;
    const proposal = (
      add.inputSchema.properties as {
        proposals: {
          items: { properties: Record<string, { description?: string; properties?: unknown }> };
        };
      }
    ).proposals.items.properties;
    const patchProps = proposal['patch']!.properties as Record<string, { description: string }>;
    for (const key of PLAN_ITEM_MARK_PATCH_KEYS) expect(patchProps[key]).toBeDefined();
    expect(patchProps['supersededByAdd']!.description).toContain(
      'On the OLD card: `supersededByAdd` names the card that REPLACES it',
    );
    expect(patchProps['supersedesAdd']!.description).toContain('On the NEWER card');
    expect(patchProps['obsolescence']!.description).toContain(
      'a plan may mark only a finished work item',
    );
    expect(proposal['supersedesRefs']).toBeDefined();
    expect(add.description).toContain('a plan may mark only a finished work item');

    const correct = tools.find((t) => t.name === UPDATE_PLAN_PROPOSAL_TOOL_NAME)!;
    expect(
      (correct.inputSchema.properties as Record<string, unknown>)['supersedesRefs'],
    ).toBeDefined();
    expect(correct.description).toContain('a plan may mark only a finished work item');
    await client.close();
  });
});

describe('add_plan_items — the APPEND door carries the mark and resolves KEYS', () => {
  it('marks a done story superseded by a story this plan adds, in two calls; get_plan renders it', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const old = await doneCard(fx, 'The old flow', 'story');
    const planId = await openPlan(client, fx);

    // Call 1 — the replacement, naming the old story BY KEY on `supersedesRefs`.
    const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'The new flow', kind: 'story' },
          supersedesRefs: [old.identifier],
        },
      ],
    });
    expect(first.isError).toBeFalsy();
    const addId = ids(first)[0]!;

    // Call 2 — a MARK-ONLY modify of the done story, superseded by the add.
    const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: old.id,
          patch: {
            obsolescence: 'outdated',
            obsolescenceNoteMd: 'The flow moved to the new story.\nDetails follow.',
            supersededByAdd: [`planItem:${addId}`],
          },
        },
      ],
    });
    expect(second.isError).toBeFalsy();

    const { plan, rendered } = await readPlan(client, planId);
    const add = plan.items.find((i) => i.op === 'add')!;
    const modify = plan.items.find((i) => i.op === 'modify')!;
    // The KEY was resolved to the id before the service stored it.
    expect(add.supersedesRefs).toEqual([old.id]);
    expect(modify.patch).toEqual({
      obsolescence: 'outdated',
      obsolescenceNoteMd: 'The flow moved to the new story.\nDetails follow.',
      supersededByAdd: [`planItem:${addId}`],
    });
    expect(rendered).toContain(`+ [story] The new flow · supersedes ${old.identifier}`);
    // The changed-key list is the stored patch's key order (jsonb's, not ours),
    // so the line is asserted around it.
    expect(rendered).toContain(`~ modify ${old.identifier} — `);
    expect(rendered).toContain(
      ` · mark: none → outdated · note: The flow moved to the new story. · ` +
        `superseded by +planItem:${addId}`,
    );
    await client.close();
  });

  it('resolves a KEY on each of the four patch lists', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const target = await doneCard(fx, 'Target');
    const a = await doneCard(fx, 'A');
    const b = await doneCard(fx, 'B');
    const c = await doneCard(fx, 'C');
    const d = await doneCard(fx, 'D');
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: {
            supersedesAdd: [a.identifier],
            supersedesRemove: [b.identifier],
            supersededByAdd: [c.identifier],
            supersededByRemove: [d.identifier],
          },
        },
      ],
    });
    expect(result.isError).toBeFalsy();

    const { plan, rendered } = await readPlan(client, planId);
    expect(plan.items[0]!.patch).toEqual({
      supersedesAdd: [a.id],
      supersedesRemove: [b.id],
      supersededByAdd: [c.id],
      supersededByRemove: [d.id],
    });
    expect(rendered).toContain(
      `supersedes +${a.identifier} −${b.identifier} · superseded by +${c.identifier} −${d.identifier}`,
    );
    await client.close();
  });

  it('refuses an UNKNOWN key on a supersedes carrier at the append, and appends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const target = await doneCard(fx, 'Target');
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { supersededByAdd: [`${fx.projectIdentifier}-99999`] },
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(result)).toContain(`${fx.projectIdentifier}-99999`);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('refuses a mark on an UNFINISHED card with the typed refusal pointing at `remove`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'Nobody will finish me' });
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: open.id, patch: { obsolescence: 'deprecated' } }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INVALID_PROPOSAL');
    expect(text(result)).toContain('a plan may mark only a finished work item');
    expect(text(result)).toContain("op: 'remove'");
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('refuses a mark outside the enum AT THE SCHEMA, naming the code', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const target = await doneCard(fx, 'Target');
    const planId = await openPlan(client, fx);

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'stale' } }],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INVALID_PROPOSAL');
    expect(text(result)).toContain('obsolescence');
    await client.close();
  });
});

describe('update_plan_proposal — the CORRECTION door replaces the mark and the supersedes set', () => {
  async function planWithMark(client: Client, fx: WorkItemFixture) {
    const old = await doneCard(fx, 'Old');
    const other = await doneCard(fx, 'Other');
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Replacement', kind: 'task' } },
        { op: 'modify', workItemId: old.id, patch: { obsolescence: 'outdated' } },
      ],
    });
    expect(appended.isError).toBeFalsy();
    const [addId, modifyId] = ids(appended) as [string, string];
    return { planId, addId, modifyId, old, other };
  }

  for (const status of ['generating', 'planned'] as const) {
    it(`replaces an add's supersedesRefs (by KEY) and a modify's six keys on a ${status} plan`, async () => {
      const fx = await makeWorkItemFixture();
      const client = await connectClient(fx.ctx);
      const { planId, addId, modifyId, old, other } = await planWithMark(client, fx);
      if (status === 'planned') {
        const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
          planId,
          proposals: [],
          final: true,
        });
        expect(closed.isError).toBeFalsy();
      }

      const onAdd = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId,
        planItemId: addId,
        supersedesRefs: [old.identifier],
      });
      expect(onAdd.isError).toBeFalsy();

      const onModify = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId,
        planItemId: modifyId,
        patch: {
          obsolescence: 'deprecated',
          obsolescenceNoteMd: 'Overturned.',
          supersedesAdd: [other.identifier],
          supersedesRemove: [],
          supersededByAdd: [`planItem:${addId}`],
          supersededByRemove: [],
        },
      });
      expect(onModify.isError).toBeFalsy();

      const { plan } = await readPlan(client, planId);
      expect(plan.status).toBe(status);
      expect(plan.items.find((i) => i.id === addId)!.supersedesRefs).toEqual([old.id]);
      expect(plan.items.find((i) => i.id === modifyId)!.patch).toEqual({
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Overturned.',
        supersedesAdd: [other.id],
        supersedesRemove: [],
        supersededByAdd: [`planItem:${addId}`],
        supersededByRemove: [],
      });
      await client.close();
    });
  }

  it('is refused on an APPROVED plan, naming the status', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, addId, old } = await planWithMark(client, fx);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });

    const result = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId,
      supersedesRefs: [old.identifier],
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('approved');
    await client.close();
  });

  it('refuses a correction that marks an UNFINISHED card', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'In flight' });
    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: open.id, patch: { priority: 'low' } }],
    });
    const modifyId = ids(appended)[0]!;

    const result = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { obsolescence: 'outdated' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('a plan may mark only a finished work item');
    await client.close();
  });
});
