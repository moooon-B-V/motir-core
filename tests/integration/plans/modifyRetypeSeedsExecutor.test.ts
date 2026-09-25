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
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { asksTheConfirmQuestion } from '@/lib/approvalGates/decisionConfirmationHandler';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import type { PlanItemPatch, PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-6259 — a plan `modify` that re-types a card could not give it an
// EXECUTOR, and `add_plan_items` dropped a `patch.executor` without a word.
//
// ── The reproduction ───────────────────────────────────────────────────────
// `add_plan_items { op: 'modify', patch: { type: 'decision', executor: … } }`
// on an UNTYPED leaf succeeded; the stored patch held `type` and no `executor`
// (`mergeModifyPatch` copies only `PLAN_ITEM_PATCH_KEYS`), and approve wrote
// `type: decision` beside `executor: null`. Both decision gates key on the pair
// — `decision_approval` on `coding_agent`, `decision_confirmation` on `human` —
// so the approved card raised NEITHER, and the decision it existed to put in
// front of a person could never be asked.
//
// ── The fix, and which of the card's two directions it is ──────────────────
// (b): the patch still has no `executor` key (AMENDMENT 4 D3a stands), a re-type
// SEEDS the type's default when the target has none — through `resolveExecutor`,
// the direct door's own rule — and a patch key the plan cannot apply is REFUSED
// by name. The review shows the seeded executor before anyone approves.
//
// Driven through the REAL tools over the REAL transport into real Postgres,
// because the drop happened between the tool and the row.

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'modify-retype-executor', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  return struct(
    await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Re-plan',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5-5',
    }),
  ).id;
}

/** An UNTYPED leaf — the shape MOTIR-6148 was filed as. */
async function untypedCard(fx: WorkItemFixture): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Which design stands?' },
    fx.ctx,
  );
  return dto.id;
}

async function plannedModify(fx: WorkItemFixture, workItemId: string, patch: PlanItemPatch) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function reviewedModify(fx: WorkItemFixture, planId: string) {
  const review = await planReviewService.getPlanReview(planId, fx.ctx);
  return review.items.find((i) => i.op === 'modify')!;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a `patch` key the plan cannot apply is REFUSED, by name', () => {
  it('`add_plan_items` refuses `patch.executor` and stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await untypedCard(fx);

    const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target,
          patch: { type: 'decision', executor: 'coding_agent' },
        },
      ],
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('`executor`');
    expect(text).toContain('INVALID_PROPOSAL');
    // Refused means ABSENT: the original defect was a success with the key gone.
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(0);
    await client.close();
  });

  it('names EVERY unknown key, not only the first', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await untypedCard(fx);

    const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'modify', workItemId: target, patch: { title: 'Kept', assignee: 'x', dueDate: 'y' } },
      ],
    });

    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('`assignee`');
    expect(text).toContain('`dueDate`');
    await client.close();
  });

  it('`update_plan_proposal` holds a replacement patch to the same check', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await untypedCard(fx);

    const added = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target, patch: { type: 'decision' } }],
    });
    expect(added.isError).toBeFalsy();
    const itemId = ids(added)[0]!;

    const res = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: itemId,
      patch: { type: 'decision', executor: 'human' },
    });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('`executor`');
    // The stored patch is the one the append wrote, untouched.
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.patch).toEqual({ type: 'decision' });
    await client.close();
  });

  it('a patch of KNOWN keys still appends — the check refuses nothing it did not have to', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(fx.ctx);
    const planId = await openPlan(client, fx);
    const target = await untypedCard(fx);

    const res = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target,
          patch: { type: 'decision', storyPoints: 2, estimateMinutes: 30, difficulty: 'low' },
        },
      ],
    });

    expect(res.isError).toBeFalsy();
    expect(ids(res)).toHaveLength(1);
    await client.close();
  });
});

describe('a re-type SEEDS the executor when the target has none', () => {
  it('the review shows the seeded executor before approve — as a change row AND on the rail', async () => {
    const fx = await makeWorkItemFixture();
    const target = await untypedCard(fx);
    const planId = await plannedModify(fx, target, { type: 'decision' });

    const item = await reviewedModify(fx, planId);
    expect(item.changes).toContainEqual({ field: 'type', from: null, to: 'decision' });
    // `decision` defaults to `human` (`DEFAULT_EXECUTOR_BY_TYPE`).
    expect(item.changes).toContainEqual({ field: 'executor', from: null, to: 'human' });
    expect(item.executor).toBe('human');
  });

  it('approve writes that executor, so the card raises the decision gate its pair names', async () => {
    const fx = await makeWorkItemFixture();
    const target = await untypedCard(fx);
    const planId = await plannedModify(fx, target, { type: 'decision' });

    await plansService.approvePlan(planId, fx.ctx);

    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: target } });
    expect(card.type).toBe('decision');
    expect(card.executor).toBe('human');
    // THE DEFECT, stated as its consequence: before the fix this pair was
    // (`decision`, null) and BOTH predicates below answered false — no gate.
    // Under the seed-if-absent rule the documented default gate is
    // `decision_confirmation`, a person confirming a decision settled with them.
    expect(asksTheConfirmQuestion(card)).toBe(true);
    expect(asksTheDecisionQuestion(card)).toBe(false);

    // The revision records the seed, so the item's activity says who set it.
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: target, changeKind: 'updated' },
      orderBy: { changedAt: 'asc' },
    });
    const withExecutor = revisions.find(
      (r) => (r.diff as Record<string, unknown>).executor !== undefined,
    );
    expect((withExecutor!.diff as Record<string, unknown>).executor).toEqual({
      from: null,
      to: 'human',
    });
  });

  it('an executor the target ALREADY carries is never clobbered, and no row claims it moves', async () => {
    const fx = await makeWorkItemFixture();
    // A `code` card seeds `coding_agent` at create — the target's own choice.
    const dto = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Record the decision', type: 'code' },
      fx.ctx,
    );
    expect(dto.executor).toBe('coding_agent');
    const planId = await plannedModify(fx, dto.id, { type: 'decision' });

    const item = await reviewedModify(fx, planId);
    expect(item.changes.map((c) => c.field)).not.toContain('executor');
    expect(item.executor).toBe('coding_agent');

    await plansService.approvePlan(planId, fx.ctx);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: dto.id } });
    expect(card.type).toBe('decision');
    expect(card.executor).toBe('coding_agent');
    // …which is the pair the planner-recorded decision gate asks on.
    expect(asksTheDecisionQuestion(card)).toBe(true);
  });

  it('a patch that does not touch `type` leaves a null executor null', async () => {
    const fx = await makeWorkItemFixture();
    const target = await untypedCard(fx);
    const planId = await plannedModify(fx, target, { title: 'Which design stands, and why' });

    const item = await reviewedModify(fx, planId);
    expect(item.changes.map((c) => c.field)).not.toContain('executor');
    expect(item.executor).toBeNull();

    await plansService.approvePlan(planId, fx.ctx);
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: target } });
    expect(card.executor).toBeNull();
  });
});
