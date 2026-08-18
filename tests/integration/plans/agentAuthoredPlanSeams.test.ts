import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The story's INTEGRATION SEAMS (Story MOTIR-2982 · Subtask MOTIR-2992).
//
// Each assertion below crosses TWO OR MORE cards, which is precisely why no
// card's own units can reach it: the tools (MOTIR-2988) produce a value the
// carrier (MOTIR-2986) stores, materialize (MOTIR-2990) reads, and the surfaces
// (MOTIR-2991) render. Every one of those four passed its own tests while the
// composition could still be broken — a stamp written under a key materialize
// does not read, an author recorded on the plan but not on its items, a tree
// whose temp-refs resolve to the wrong parent.
//
// So these drive the REAL producer into the REAL consumer: the tools over the
// real MCP transport, the real services, real Postgres. Nothing is mocked and
// nothing is asserted twice from a different angle.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'seams', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

/** Author a two-layer tree over the REAL tools, as an agent would. */
async function authorTree(client: Client, fx: WorkItemFixture) {
  const plan = struct(
    await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Marketplace payouts',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    }),
  );
  const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId: plan.id,
    proposals: [{ op: 'add', proposedFields: { title: 'Payouts', kind: 'story' } }],
  });
  const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId: plan.id,
    final: true,
    proposals: [
      {
        op: 'add',
        proposedFields: { title: 'Seller onboarding', kind: 'subtask', storyPoints: 3 },
        parentRef: `${TEMP_REF_PREFIX}${ids(first)[0]}`,
      },
    ],
  });
  return { planId: plan.id, storyItemId: ids(first)[0]!, leafItemId: ids(second)[0]! };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('author → approve — the provenance survives the whole chain', () => {
  it('stamps `mcp · <harness> · <model>` on every item the approved plan creates', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const { planId } = await authorTree(client, fx);

    await plansService.approvePlan(planId, fx.ctx);

    // Read back through the DTO a client actually sees, not off the row: the
    // mapper STRIPS the model for `native`, so reading the column would pass
    // even if the strip were mis-keyed and hid an agent's model too.
    const created = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId, title: { in: ['Payouts', 'Seller onboarding'] } },
    });
    expect(created).toHaveLength(2);
    for (const row of created) {
      const dto = await workItemsService.getWorkItemByIdentifier(
        fx.projectId,
        row.identifier,
        fx.ctx,
      );
      expect(dto.planningSource).toBe('mcp');
      expect(dto.planningHarness).toBe('Claude Code');
      expect(dto.planningModel).toBe('claude-opus-5');
    }
    await client.close();
  });

  it('leaves a Motir-generated plan materializing as `native · Motir`, model stripped', async () => {
    const fx = await makeWorkItemFixture();
    // The shipped generator path: no authorship on the plan, no provenance on
    // the proposal. It must be byte-identical to its behaviour before this story
    // — that is what makes the lifted pin (MOTIR-2990) a safe change.
    const plan = await plansService.createPlan(fx.projectId, { sourceJobId: 'job_1' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Generated task',
            kind: 'task',
            planningProvenance: { source: 'native', harness: 'Motir', model: 'deepseek-chat' },
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const row = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Generated task' } });
    expect(row.planningSource).toBe('native');
    expect(row.planningModel).toBe('deepseek-chat'); // RECORDED on the row…
    const dto = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      row.identifier,
      fx.ctx,
    );
    expect(dto.planningModel).toBeNull(); // …and STRIPPED at the boundary.
    expect(dto.planningHarness).toBe('Motir');
  });
});

describe('author → read back — the proposed TREE survives the wire', () => {
  it('reconstructs the parent nesting from the ids the append returned', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const { planId, storyItemId, leafItemId } = await authorTree(client, fx);

    // The seam an APPEND-ORDER mistake hides in: both tools' own units pass
    // while the second batch hangs its children off the wrong proposal.
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const leaf = review.items.find((i) => i.planItemId === leafItemId);
    const story = review.items.find((i) => i.planItemId === storyItemId);
    expect(leaf).toBeTruthy();
    expect(story).toBeTruthy();
    // The canvas places the leaf UNDER the story the first batch created — i.e.
    // the temp-ref resolved to the right proposal, not merely to some proposal.
    expect(leaf!.parentNodeId).toBe(story!.nodeId);

    const plan = await plansService.getPlan(planId, fx.ctx);
    const leafRow = plan.items.find((i) => i.id === leafItemId)!;
    expect(leafRow.parentRef).toBe(`${TEMP_REF_PREFIX}${storyItemId}`);
    await client.close();
  });
});

describe('nothing exists until APPROVE — the story’s single most important property', () => {
  it('leaves the project’s work-item count unchanged through authoring and closing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const { planId } = await authorTree(client, fx);

    // Asserted as a project-wide COUNT, not the absence of a particular title:
    // the property is that authoring a whole tree writes nothing to the tree.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);

    await plansService.approvePlan(planId, fx.ctx);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before + 2);
    await client.close();
  });

  it('DECLINE leaves the tree untouched', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const { planId } = await authorTree(client, fx);

    await plansService.declinePlan(planId, fx.ctx);

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    await client.close();
  });
});

describe('the authorship reaches BOTH projections, which are maintained separately', () => {
  it('appears on the PlanDto the list binds and the PlanReviewDto the detail fetches', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const { planId } = await authorTree(client, fx);

    // Two shapes, two builders. One being right proves nothing about the other,
    // which is exactly how a surface ends up with a stored-but-unreachable value.
    const listShape = await plansService.getPlan(planId, fx.ctx);
    const detailShape = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(listShape.authorSource).toBe('mcp');
    expect(listShape.authorHarness).toBe('Claude Code');
    expect(listShape.createdById).toBe(fx.ownerId);

    expect(detailShape.authorSource).toBe('mcp');
    expect(detailShape.authorHarness).toBe('Claude Code');
    expect(detailShape.authorModel).toBe('claude-opus-5');
    expect(detailShape.createdByName).toBe(fx.owner.name);
    await client.close();
  });
});
