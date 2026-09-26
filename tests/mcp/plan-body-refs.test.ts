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
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A proposal body's item link WITHOUT the `planItem:` prefix is REFUSED at every
// plan door (bug MOTIR-6494). `[label](motir-ref:<id>)` matched no reader, so it
// was accepted at the append and shipped as dead text at approve. Each door is
// proven by CALLING it: the three MCP tools a plan author writes bodies through.
//
// Real Postgres, the real MCP server over the in-memory transport.

const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-body-refs', version: '0.0.0' });
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
    title: 'A plan whose cards link each other',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5-5',
  });
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as unknown as { id: string }).id;
}

/** Append one plain `add` and return its planItem id — the sibling a body links to. */
async function appendSibling(client: Client, planId: string): Promise<string> {
  const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The sibling', kind: 'task' } }],
  });
  expect(appended.isError).toBeFalsy();
  return ids(appended)[0]!;
}

function expectRefusedNaming(result: CallToolResult, token: string): void {
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('INVALID_PROPOSAL');
  expect(text(result)).toContain(token);
  expect(text(result)).toContain('motir-ref:planItem:<planItemId>');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add_plan_items — the APPEND door', () => {
  it('refuses an `add` whose descriptionMd links a sibling without `planItem:`, naming the token, and appends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);
    const token = `[the sibling](motir-ref:${sibling})`;

    const result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Links it', kind: 'task', descriptionMd: `Needs ${token}.` },
        },
      ],
    });
    expectRefusedNaming(result, token);
    expect(text(result)).toContain('descriptionMd');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
    await client.close();
  });

  it('refuses the same form in an `add`’s explanationMd and in a `modify`’s patch', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);
    const token = `[x](motir-ref:${sibling})`;
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });

    const onExplanation = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Why', kind: 'task', explanationMd: token } },
      ],
    });
    expectRefusedNaming(onExplanation, token);
    expect(text(onExplanation)).toContain('explanationMd');

    const onPatch = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'modify', workItemId: target.id, patch: { descriptionMd: `Now after ${token}.` } },
      ],
    });
    expectRefusedNaming(onPatch, token);
    await client.close();
  });

  it('accepts the canonical form, and approve rewrites it to the created sibling’s `motir:<id>`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [
        {
          op: 'add',
          proposedFields: {
            title: 'Links it',
            kind: 'task',
            // A link inside inline code is literal text, not a link, so it is not refused.
            descriptionMd: `Needs [the sibling](motir-ref:planItem:${sibling}). Syntax: \`[x](motir-ref:<id>)\`.`,
          },
        },
      ],
    });
    expect(appended.isError).toBeFalsy();

    await plansService.approvePlan(planId, fx.ctx);
    const [created, linker] = await Promise.all([
      adminDb.workItem.findFirstOrThrow({
        where: { projectId: fx.projectId, title: 'The sibling' },
      }),
      adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId, title: 'Links it' } }),
    ]);
    expect(linker.descriptionMd).toBe(
      `Needs [the sibling](motir:${created.id}). Syntax: \`[x](motir-ref:<id>)\`.`,
    );
    await client.close();
  });
});

describe('update_plan_item — the DEEPEN door', () => {
  it('refuses a deepen whose body links a sibling without `planItem:`, and leaves the proposal as it was', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const sibling = await appendSibling(client, planId);
    const token = `[the sibling](motir-ref:${sibling})`;

    const result = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: sibling,
      explanationMd: `Matters because of ${token}.`,
    });
    expectRefusedNaming(result, token);
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: sibling } });
    expect((row.proposedFields as { explanationMd?: string }).explanationMd).toBeUndefined();
    await client.close();
  });
});

describe('update_plan_proposal — the CORRECTION door', () => {
  it('refuses a correction of an `add` and of a `modify`’s patch on a CLOSED plan', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await createTestWorkItem(fx, { title: 'A committed leaf', kind: 'task' });
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      final: true,
      proposals: [
        { op: 'add', proposedFields: { title: 'Correct me', kind: 'task' } },
        { op: 'modify', workItemId: target.id, patch: { priority: 'low' } },
      ],
    });
    const [addId, modifyId] = ids(appended);
    const token = `[the add](motir-ref:${addId})`;

    const onAdd = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId!,
      descriptionMd: `See ${token}.`,
    });
    expectRefusedNaming(onAdd, token);

    const onModify = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId!,
      patch: { priority: 'low', descriptionMd: `After ${token}.` },
    });
    expectRefusedNaming(onModify, token);
    await client.close();
  });
});
