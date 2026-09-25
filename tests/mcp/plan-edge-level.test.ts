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
import { VALIDATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/validatePlan';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6367 (Story MOTIR-6015) — the plan gate's EDGE RULE through the real MCP
// handlers and real Postgres: a `blocked_by` joins two items on the SAME LEVEL
// (epic · story · leaf), may cross parents, and may not cross levels. The pure
// verdict is pinned in `tests/plans/validateProposals.test.ts`; this file pins
// the doors — the append, the correction, `validate_plan` — and that a refusal
// appends nothing.
//
// The tree every case reads:
//   epic E1 ─ story A ─ subtask Y
//          └ story B
//   epic E2 ─ story C

const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;
const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-edge-level', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const r = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Edge-level plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5-5',
  });
  expect(r.isError, text(r)).toBeFalsy();
  return struct(r).id;
}

async function tree(fx: WorkItemFixture) {
  const mk = (kind: 'epic' | 'story' | 'subtask', title: string, parentId?: string) =>
    workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const e1 = await mk('epic', 'Epic one');
  const e2 = await mk('epic', 'Epic two');
  const a = await mk('story', 'Story A', e1.id);
  const b = await mk('story', 'Story B', e1.id);
  const c = await mk('story', 'Story C', e2.id);
  const y = await mk('subtask', 'Subtask Y', a.id);
  return { e1, e2, a, b, c, y };
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add_plan_items — a cross-LEVEL edge is refused where it is written', () => {
  it('a subtask `add` blocked_by a STORY → INVALID_PLAN_REF_GRAPH / cross_level, nothing appended', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Subtask X', kind: 'subtask' },
          parentRef: t.b.id,
          // A KEY, as an agent sends it — resolved to the id at the append.
          blockedByRefs: [t.a.identifier],
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(refused)).toContain('cross_level');
    expect(text(refused)).toContain('Subtask X');
    expect(text(refused)).toContain(t.a.identifier);
    expect(text(refused)).toMatch(/level: leaf/);
    expect(text(refused)).toMatch(/level: story/);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it("a `modify`'s patch.blockedByAdd across levels is refused the same way", async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.y.id, patch: { blockedByAdd: [t.c.id] } }],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('cross_level');
    expect(text(refused)).toContain('patch.blockedByAdd');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });
});

describe('add_plan_items — a SAME-level edge across parents is accepted', () => {
  it('subtask→subtask in another story, story→story in another epic, bug→subtask: appended, closed, VALID', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Subtask X', kind: 'subtask' },
          parentRef: t.b.id,
          blockedByRefs: [t.y.id],
        },
        {
          op: 'add',
          proposedFields: { title: 'Story D', kind: 'story' },
          parentRef: t.e2.id,
          blockedByRefs: [t.a.id],
        },
        {
          op: 'add',
          proposedFields: { title: 'A bug', kind: 'bug' },
          parentRef: t.c.id,
          blockedByRefs: [t.y.id],
        },
      ],
    });
    expect(appended.isError, text(appended)).toBeFalsy();

    const validated = await call(client, VALIDATE_PLAN_TOOL_NAME, { planId });
    expect(validated.isError, text(validated)).toBeFalsy();
    expect(validated.structuredContent).toMatchObject({ valid: true, rejections: [] });

    const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [],
      final: true,
    });
    expect(closed.isError, text(closed)).toBeFalsy();
    expect(struct(closed).status).toBe('planned');
    await client.close();
  });

  it('patch.blockedByRemove of a committed CROSS-LEVEL edge is accepted — a bad edge can always go', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    // Written below every door, as a pre-rule edge would have been.
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId: t.y.id,
        toId: t.c.id,
        kind: 'is_blocked_by',
        createdById: fx.ctx.userId,
      },
    });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.y.id, patch: { blockedByRemove: [t.c.id] } }],
      final: true,
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    expect(struct(appended).status).toBe('planned');
    await client.close();
  });
});

describe('update_plan_proposal — re-kinding an `add` under an edge it carries', () => {
  it('turning the blocked add into a STORY is refused cross_level, and the proposal is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Blocker', kind: 'task' }, parentRef: t.b.id },
      ],
    });
    expect(first.isError, text(first)).toBeFalsy();
    const [blocker] = ids(first);
    const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Blocked', kind: 'task' },
          blockedByRefs: [`planItem:${blocker}`],
        },
      ],
    });
    expect(second.isError, text(second)).toBeFalsy();
    const [blocked] = ids(second);

    const refused = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: blocked,
      kind: 'story',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(refused)).toContain('cross_level');
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: blocked } });
    expect((row.proposedFields as { kind: string }).kind).toBe('task');
    await client.close();
  });
});

describe('validate_plan — a cross-level edge appended BEFORE the rule shipped', () => {
  it('is reported as a cross_level rejection, and an unrelated append is still accepted', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    // The row as an append that predates this card left it — below every door.
    const legacy = await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        proposedFields: { title: 'Legacy subtask', kind: 'subtask' },
        parentRef: t.b.id,
        blockedByRefs: [t.a.id],
      },
    });

    // The append judges only what it writes, so the plan stays repairable.
    const unrelated = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Unrelated', kind: 'story' }, parentRef: t.e1.id },
      ],
    });
    expect(unrelated.isError, text(unrelated)).toBeFalsy();

    const validated = await call(client, VALIDATE_PLAN_TOOL_NAME, { planId });
    expect(validated.isError, text(validated)).toBeFalsy();
    const verdict = validated.structuredContent as {
      valid: boolean;
      rejections: { code: string; reason: string; item: string }[];
    };
    expect(verdict.valid).toBe(false);
    expect(verdict.rejections).toEqual([
      expect.objectContaining({
        code: 'INVALID_PLAN_REF_GRAPH',
        reason: 'cross_level',
        item: `planItem:${legacy.id}`,
      }),
    ]);

    // …and the close refuses it too — the same gate approve runs.
    const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [],
      final: true,
    });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain('cross_level');
    await client.close();
  });
});
