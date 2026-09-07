import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import { TODO_TEXT_MAX_LENGTH } from '@/lib/workItemTodos/limits';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ════════════════════════════════════════════════════════════════════════════
// STORY GATE — the core side of MOTIR-3810 (Subtask MOTIR-4624).
//
// Five code cards built this feature and each ships its own units. What no unit
// sees is the ASSEMBLED path: a proposal authored through the MCP door, read
// back by the review model the peek renders, approved, and then read as real
// rows through the SAME service the item page uses. Every hop in that chain is
// green in isolation today; the chain itself is what this file asserts.
//
// It enumerates no case a feature card already ships. Where a case here looks
// like a duplicate, the difference is the DRIVER: the unit calls a service with
// a hand-built input, and this calls the tool a real agent calls and reads the
// result through the surface a real reviewer opens.
//
// Real Postgres, per CLAUDE.md — three of the four seams below are about what
// crosses a transaction boundary, and a mock can prove none of them.
// ════════════════════════════════════════════════════════════════════════════

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
  const client = new Client({ name: 'story-gate', version: '0.0.0' });
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

/** Author a plan with ONE `manual` add carrying `todos`, through the real tools. */
async function authorPlanWithSteps(
  client: Client,
  fx: WorkItemFixture,
  // ⚠️ NO DEFAULT. A default parameter fires on an explicit `undefined`, so a
  // caller asking for a STEPLESS proposal would silently get a four-step one —
  // and the case that needs it is the deepen, whose whole point is starting
  // from none. Every call site says what it means.
  todos: unknown,
): Promise<{ planId: string; planItemId: string }> {
  const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Billing, provisioned',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = struct(opened).id;
  const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [
      {
        op: 'add',
        proposedFields: {
          title: 'Provision the Stripe restricted key',
          kind: 'task',
          type: 'manual',
          executor: 'human',
          storyPoints: 2,
          estimateMinutes: 30,
          todos,
        },
      },
    ],
  });
  return { planId, planItemId: ids(appended)[0]! };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
  vi.restoreAllMocks();
});

// ── SEAM 1 · append → read ──────────────────────────────────────────────────
describe('append → read: the steps survive from the tool to the review model', () => {
  it('reach `get_plan`, the review model with the executor RESOLVED, and the peek envelope', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await authorPlanWithSteps(client, fx, FOUR_STEPS);

    // The plan the agent reads back.
    const read = await call(client, 'get_plan', { planId });
    expect(struct(read).items[0]!.proposedFields!.todos).toEqual(FOUR_STEPS);
    expect(text(read)).toContain('· 4 steps');

    // The model the REVIEWER's surface renders — the same rows, with the
    // executor seed applied, which is the whole point of the projection: the
    // peek must show what approve will WRITE.
    await plansService.markPlanned(planId, fx.ctx);
    const item = (await planReviewService.getPlanReview(planId, fx.ctx)).items[0]!;
    expect(item.todos?.map((t) => [t.text, t.executor])).toEqual([
      ['Create a restricted API key', 'human'],
      ['Scope it to charges:write', 'human'],
      ['Set the deployment secret', 'coding_agent'],
      ['Confirm a test charge succeeds', 'human'],
    ]);
    // One array, two carriers — never a second derivation.
    expect(item.proposal.todos).toEqual(item.todos);

    await client.close();
  });
});

// ── SEAM 2 · deepen / correct → read ────────────────────────────────────────
describe('deepen and correct → read: a replaced list reaches the review model', () => {
  it('the DEEPEN sets it while generating, and the CORRECTION clears it after the close', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, planItemId } = await authorPlanWithSteps(client, fx, undefined);

    // ⚠️ THE DEEPEN IS `generating`-ONLY — the two doors are not
    // interchangeable, and asserting the call's own result is what makes that
    // visible here rather than three lines later as a puzzling `null`.
    const deepened = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      todos: [{ text: 'The only step' }],
    });
    expect(deepened.isError).toBeFalsy();

    await plansService.markPlanned(planId, fx.ctx);
    let item = (await planReviewService.getPlanReview(planId, fx.ctx)).items[0]!;
    expect(item.todos).toEqual([
      { text: 'The only step', notesMd: null, commandText: null, executor: 'human' },
    ]);

    // Past the close the door is the CORRECTION one. `[]` clears, and the
    // review model reports `null` — not an empty array — so the peek renders NO
    // section rather than an empty `0 of 0`.
    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId,
      todos: [],
    });
    expect(corrected.isError).toBeFalsy();
    item = (await planReviewService.getPlanReview(planId, fx.ctx)).items[0]!;
    expect(item.todos).toBeNull();

    await client.close();
  });
});

// ── SEAM 3 · approve → list ─────────────────────────────────────────────────
describe('approve → list: the proposal’s steps become the card’s rows', () => {
  it('drives the WHOLE chain and reads the result through the item page’s own service', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await authorPlanWithSteps(client, fx, FOUR_STEPS);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    await client.close();

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Provision the Stripe restricted key' },
    });

    // `listTodos` is the read the item page renders. Driving it from a REAL
    // proposal is what this gate adds over the materialize card's own test,
    // which builds its input by hand.
    const list = await workItemTodosService.listTodos(created.id, fx.ctx);
    expect(list.items.map((t) => t.text)).toEqual(FOUR_STEPS.map((s) => s.text));
    expect(list.progress).toEqual({ done: 0, total: 4 });
    expect(list.items.every((t) => !t.done)).toBe(true);
    expect(list.items.map((t) => t.executor)).toEqual(['human', 'human', 'coding_agent', 'human']);
    expect(list.items[2]!.commandText).toBe('fly secrets set STRIPE_KEY=… -a motir');
    expect(list.items[1]!.notesMd).toBe('Dashboard → Developers → API keys.');

    // ⚠️ THE REVIEWER'S PREVIEW AND THE CARD MUST NOT DIFFER — that is the
    // story's own promise, and it is the one assertion no single card can make.
    const reviewed = (await planReviewService.getPlanReview(planId, fx.ctx)).items[0]!;
    expect(reviewed.todos?.map((t) => [t.text, t.notesMd, t.commandText, t.executor])).toEqual(
      list.items.map((t) => [t.text, t.notesMd, t.commandText, t.executor]),
    );
  });
});

// ── SEAM 4 · the BAR, at every door ─────────────────────────────────────────
describe('the granularity bar is the same at every door', () => {
  const OVER = 'x'.repeat(TODO_TEXT_MAX_LENGTH + 1);

  it.each([
    ['add_plan_items', 'append'],
    [UPDATE_PLAN_ITEM_TOOL_NAME, 'deepen'],
    [UPDATE_PLAN_PROPOSAL_TOOL_NAME, 'correct'],
  ])('%s refuses an over-cap row with the store’s own message', async (_tool, door) => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    let result: CallToolResult;
    if (door === 'append') {
      const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
        projectKey: fx.projectIdentifier,
      });
      result = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: struct(opened).id,
        proposals: [
          { op: 'add', proposedFields: { title: 'Bad', kind: 'task', todos: [{ text: OVER }] } },
        ],
      });
    } else {
      const { planId, planItemId } = await authorPlanWithSteps(client, fx, undefined);
      if (door === 'correct') await plansService.markPlanned(planId, fx.ctx);
      result = await call(
        client,
        door === 'deepen' ? UPDATE_PLAN_ITEM_TOOL_NAME : UPDATE_PLAN_PROPOSAL_TOOL_NAME,
        { planId, planItemId, todos: [{ text: OVER }] },
      );
    }

    expect(result.isError).toBe(true);
    // The STORE's message, not a door-local one — the bar has one home.
    expect(text(result)).toContain('Split it into two steps');
    expect(text(result)).toContain('step 1');
    await client.close();
  });
});

// ── GUARDS COVERAGE CANNOT SEE ──────────────────────────────────────────────
describe('guards a coverage number cannot see', () => {
  it('materialized rows carry the PLAN’s workspace, and no other', async () => {
    const fx = await makeWorkItemFixture();
    // A second tenant, seeded so "the right workspace" is a discriminating
    // assertion rather than a tautology on a single-workspace database.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    expect(other.ctx.workspaceId).not.toBe(fx.ctx.workspaceId);

    const client = await connectClient(fx.ctx);
    const { planId } = await authorPlanWithSteps(client, fx, FOUR_STEPS);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    await client.close();

    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Provision the Stripe restricted key' },
    });
    const rows = await adminDb.workItemTodo.findMany({ where: { workItemId: created.id } });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([fx.ctx.workspaceId]));

    // And the other tenant's rows are not these: the second workspace has none.
    const otherRows = await adminDb.workItemTodo.findMany({
      where: { workspaceId: other.ctx.workspaceId },
    });
    expect(otherRows).toEqual([]);
  });

  it('a `modify` may not carry steps, and a committed card’s list survives approve untouched', async () => {
    const fx = await makeWorkItemFixture();
    // A committed card with a list somebody has already made progress on — the
    // exact thing AMENDMENT 14 D2 refuses to let a plan rewrite.
    const target = await createTestWorkItem(fx, { title: 'A card mid-flight', kind: 'task' });
    await workItemTodosService.addTodo(target.id, { text: 'Already done by a person' }, fx.ctx);
    const before = await workItemTodosService.listTodos(target.id, fx.ctx);
    expect(before.items).toHaveLength(1);

    const client = await connectClient(fx.ctx);
    const opened = await call(client, CREATE_PLAN_TOOL_NAME, { projectKey: fx.projectIdentifier });
    const planId = struct(opened).id;
    // Smuggled onto the patch: the schema declares no `todos` there, and
    // `applyModify` writes only `PLAN_ITEM_PATCH_KEYS`.
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { title: 'A re-scoped title', todos: [{ text: 'Should never land' }] },
        },
      ],
    });
    await plansService.markPlanned(planId, fx.ctx);

    // The review model shows no steps for a `modify` — Part XV §15.4.
    const item = (await planReviewService.getPlanReview(planId, fx.ctx)).items[0]!;
    expect(item.todos).toBeNull();
    expect(item.proposal.todos).toBeNull();

    await plansService.approvePlan(planId, fx.ctx);
    await client.close();

    // The person's row is exactly as it was. Nothing was added, replaced or
    // cleared — a plan is not the editor of somebody's progress.
    const after = await workItemTodosService.listTodos(target.id, fx.ctx);
    expect(after.items.map((t) => t.text)).toEqual(['Already done by a person']);
    expect(after.items[0]!.id).toBe(before.items[0]!.id);
  });

  it('a failure on a later row rolls the WHOLE approve back — no card with half a list', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await authorPlanWithSteps(client, fx, FOUR_STEPS);
    await plansService.markPlanned(planId, fx.ctx);
    await client.close();

    const real = workItemTodoRepository.create;
    let calls = 0;
    const spy = vi
      .spyOn(workItemTodoRepository, 'create')
      .mockImplementation(async (data, tx) =>
        ++calls === 3 ? Promise.reject(new Error('boom')) : real(data, tx),
      );
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toThrow('boom');
    spy.mockRestore();

    expect(
      await adminDb.workItem.findFirst({
        where: { title: 'Provision the Stripe restricted key' },
      }),
    ).toBeNull();
    expect(await adminDb.workItemTodo.count()).toBe(0);
    // …and the plan is still reviewable, rather than half-applied.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
  });

  it('the v1 contract MOVED for the new field — a client can tell the two servers apart', () => {
    // A new optional field on a response is a MINOR bump, and MOTIR-3157 is the
    // bug filed the last time a shape moved without the number.
    const [major, minor] = V1_CONTRACT_VERSION.split('.').map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(25);
  });
});
