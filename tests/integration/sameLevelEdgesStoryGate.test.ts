import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { InvalidEdgeDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY GATE for Story MOTIR-6015 in motir-core (MOTIR-6372) — the seams the
// feature cards' units stub, end to end: the real MCP handlers over the real
// persist gate (MOTIR-6367), the real link service (MOTIR-6369), the real
// validity reads over committed rows and over a plan projection (MOTIR-6370),
// all reading ONE level predicate — POSITION, not kind (MOTIR-6387 / 6411).
// Nothing here mocks the persist gate, the link service or the validity reads.
//
// The seed every case reads:
//   epic E1 ─ story A ─ subtask Y
//          └ story B ─ subtask X
//   epic E2 ─ story C

const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'same-level-edges-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

async function seed(fx: WorkItemFixture) {
  const mk = (kind: 'epic' | 'story' | 'subtask', title: string, parentId?: string) =>
    workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const e1 = await mk('epic', 'E1');
  const e2 = await mk('epic', 'E2');
  const a = await mk('story', 'A', e1.id);
  const b = await mk('story', 'B', e1.id);
  const c = await mk('story', 'C', e2.id);
  const y = await mk('subtask', 'Y', a.id);
  const x = await mk('subtask', 'X', b.id);
  return { e1, e2, a, b, c, y, x };
}

const link = (fx: WorkItemFixture, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

type Validity = { valid: boolean; blockers: unknown[]; invalidEdges: InvalidEdgeDto[] };

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const r = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Story gate plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5-5',
  });
  return (r.structuredContent as unknown as PlanWithItemsDto).id;
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

describe('the plan gate, end to end through add_plan_items', () => {
  it('a subtask blocked_by a story is refused `cross_level`, and nothing is appended', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const refused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Subtask under B', kind: 'subtask' },
          parentRef: t.b.id,
          blockedByRefs: [t.a.id],
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('INVALID_PLAN_REF_GRAPH');
    expect(text(refused)).toContain('cross_level');
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('a bug blocked_by a subtask in ANOTHER story (the same depth) is accepted and closes', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'A bug under B', kind: 'bug' },
          parentRef: t.b.id,
          blockedByRefs: [t.y.id],
        },
      ],
      final: true,
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    expect((appended.structuredContent as unknown as PlanWithItemsDto).status).toBe('planned');
    await client.close();
  });
});

describe('the link door, end to end through link_work_items', () => {
  it('subtask → story is refused CROSS_LEVEL_LINK with no row written; relates_to for the pair is created', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    const client = await connectClient(fx.ctx);

    const refused = await call(client, 'link_work_items', {
      fromKey: t.x.identifier,
      toKey: t.a.identifier,
      relationship: 'blocked_by',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('CROSS_LEVEL_LINK');
    expect(await adminDb.workItemLink.count({ where: { kind: 'is_blocked_by' } })).toBe(0);

    const related = await call(client, 'link_work_items', {
      fromKey: t.x.identifier,
      toKey: t.a.identifier,
      relationship: 'relates_to',
    });
    expect(related.isError, text(related)).toBeFalsy();
    await client.close();
  });
});

describe('validity over COMMITTED rows', () => {
  it('X → Y without B → A is an invalidEdges entry on validate_work_item(E1); linking B → A clears it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    const client = await connectClient(fx.ctx);

    const before = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(before.invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
      },
    ]);
    expect(before.valid).toBe(false);

    await link(fx, t.b.id, t.a.id);
    const after = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(after.invalidEdges).toEqual([]);
    expect(after.valid).toBe(true);
    await client.close();
  });

  it('a story edge across epics is invalid until the epics carry it', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.b.id, t.c.id);
    const client = await connectClient(fx.ctx);

    const before = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(before.invalidEdges.map((e) => [e.itemParent, e.blockerParent])).toEqual([
      [t.e1.identifier, t.e2.identifier],
    ]);

    await link(fx, t.e1.id, t.e2.id);
    const after = (await call(client, 'validate_work_item', { key: t.e1.identifier }))
      .structuredContent as unknown as Validity;
    expect(after.invalidEdges).toEqual([]);
    await client.close();
  });
});

describe('validity over a PROJECTION', () => {
  it('a plan proposing B → A leaves no entry', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByAdd: [t.a.id] } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const verdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(verdict.invalidEdges).toEqual([]);
    await client.close();
  });

  it('a plan removing a committed B → A has the entry', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);
    await link(fx, t.b.id, t.a.id);
    const client = await connectClient(fx.ctx);

    const planId = await openPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: t.b.id, patch: { blockedByRemove: [t.a.id] } }],
    });
    expect(appended.isError, text(appended)).toBeFalsy();
    const verdict = (await call(client, 'validate_plan', { planId }))
      .structuredContent as unknown as Validity;
    expect(verdict.invalidEdges).toEqual([
      {
        item: t.x.identifier,
        blockedBy: t.y.identifier,
        itemParent: t.b.identifier,
        blockerParent: t.a.identifier,
      },
    ]);
    await client.close();
  });
});

describe('the scope claim is decoupled from invalidEdges', () => {
  it('story B with an uncovered edge and no open out-of-subtree blocker is claimable; with an open one it is not_finishable', async () => {
    const fx = await makeWorkItemFixture();
    const t = await seed(fx);
    await link(fx, t.x.id, t.y.id);

    const refused = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: t.b.identifier },
      fx.ctx,
    );
    expect(refused.outcome).toBe('not_finishable');

    await adminDb.workItem.update({ where: { id: t.y.id }, data: { status: 'done' } });
    const validity = await workItemsService.validateWorkItem(fx.projectId, t.b.identifier, fx.ctx);
    expect(validity.blockers).toEqual([]);
    expect(validity.invalidEdges).toHaveLength(1);

    const claimed = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: t.b.identifier },
      fx.ctx,
    );
    expect(claimed.outcome).toBe('claimed');
  });
});
