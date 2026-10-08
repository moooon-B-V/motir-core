import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { permissionDenial } from '@/lib/mcp/permissionGate';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// AMENDMENT 24 — `update_plan_item { revision: true }`: an agent rewrites what a
// card SAYS on a plan it already closed, in place, instead of withdrawing the card
// and appending a copy (which loses its id, its edges and its history).
//
// Asserted over a real MCP client, as `append-to-planned-plan.test.ts` does for
// the append's flag: the flag reaches the service, the card keeps its id and its
// edge, the plan stays `planned`, the trail names the AGENT, and the door without
// the flag still refuses a landed plan.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'revise-plan-proposal', version: '0.0.0' });
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

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** A story and a task blocked by it, appended and CLOSED over the real door. */
async function closedPlan(client: Client, fx: WorkItemFixture) {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A plan that landed',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;
  const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [
      {
        op: 'add',
        proposedFields: { title: 'The story', kind: 'story', descriptionMd: 'old words' },
      },
    ],
  });
  const storyId = (first.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;
  const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [
      {
        op: 'add',
        proposedFields: { title: 'The task', kind: 'task' },
        blockedByRefs: [`planItem:${storyId}`],
      },
    ],
  });
  const taskId = (second.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
  return { planId, storyId, taskId };
}

describe('a revision rewrites a landed card in place', () => {
  it('edits the SAME proposal, keeps its edge, and leaves the plan `planned`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, storyId, taskId } = await closedPlan(client, fx);

    const revised = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: storyId,
      revision: true,
      title: 'The story, revised',
      descriptionMd: 'new words',
    });

    expect(revised.isError).toBeFalsy();
    const story = await adminDb.planItem.findUniqueOrThrow({ where: { id: storyId } });
    const fields = story.proposedFields as {
      title?: string;
      descriptionMd?: string;
      kind?: string;
    };
    expect(fields.title).toBe('The story, revised');
    expect(fields.descriptionMd).toBe('new words');
    expect(fields.kind).toBe('story');
    const task = await adminDb.planItem.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.blockedByRefs).toEqual([`planItem:${storyId}`]);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    expect(textOf(revised)).toContain('Revised proposal');
    expect(textOf(revised)).toContain('did NOT re-open');
  });

  it('records the edit under the AGENT that made it, not as a reviewer’s edit', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, storyId } = await closedPlan(client, fx);

    await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: storyId,
      revision: true,
      descriptionMd: 'new words',
    });

    const row = await adminDb.planRevision.findFirstOrThrow({
      where: { planId, planItemId: storyId, changeKind: 'edited' },
      orderBy: { changedAt: 'desc' },
    });
    expect(row.actorHarness).toBe('Claude Code');
    expect(row.actorModel).toBe('claude-opus-5');
    expect((row.diff as { revision?: boolean }).revision).toBe(true);
  });

  it('without the flag, a landed plan is still refused — naming its status', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, storyId } = await closedPlan(client, fx);

    const refused = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: storyId,
      descriptionMd: 'new words',
    });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('planned');
    const story = await adminDb.planItem.findUniqueOrThrow({ where: { id: storyId } });
    expect((story.proposedFields as { descriptionMd?: string }).descriptionMd).toBe('old words');
  });

  it('on a `generating` plan the flag changes nothing — it is an ordinary deepen', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const created = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Still writing',
    });
    const planId = (created.structuredContent as unknown as { id: string }).id;
    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'A task', kind: 'task' } }],
    });
    const id = (added.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;

    const deepened = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: id,
      revision: true,
      descriptionMd: 'filled in',
    });

    expect(deepened.isError).toBeFalsy();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'generating',
    );
    expect(textOf(deepened)).toContain('Still `generating`');
  });
});

describe('the boundary is unmoved', () => {
  it('a decided plan stays frozen, flag or not', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, storyId } = await closedPlan(client, fx);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });

    const refused = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: storyId,
      revision: true,
      descriptionMd: 'too late',
    });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('declined');
  });

  it('the correction door does not inherit the flag', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const props = (name: string) =>
      Object.keys(
        (tools.find((t) => t.name === name)!.inputSchema as { properties: object }).properties,
      );
    expect(props(UPDATE_PLAN_ITEM_TOOL_NAME)).toContain('revision');
    expect(props(UPDATE_PLAN_PROPOSAL_TOOL_NAME)).not.toContain('revision');
  });

  it('a CLI-minted token is still refused — the flag is an argument, not a capability', () => {
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    expect(TOOL_PERMISSIONS[UPDATE_PLAN_ITEM_TOOL_NAME]).toBe('ai:view_plan');
    expect(permissionDenial(UPDATE_PLAN_ITEM_TOOL_NAME, [...CLI_TOKEN_GRANT])).not.toBeNull();
  });
});
