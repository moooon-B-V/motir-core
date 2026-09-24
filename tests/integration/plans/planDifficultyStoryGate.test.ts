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
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { CHANGE_KIND_TOOL_NAME } from '@/lib/mcp/tools/changeKind';
import { mintJobToken } from '@/lib/ai/jobToken';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { PlanGrammarError } from '@/lib/plans/errors';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ════════════════════════════════════════════════════════════════════════════
// STORY GATE — the motir-core side of MOTIR-6095 (Subtask MOTIR-6141).
//
// Four motir-core cards built "a plan proposal carries a leaf's DIFFICULTY"
// (MOTIR-6133 the wire, MOTIR-6136 the doors, MOTIR-6137 the review, MOTIR-6135
// the authored-bug seam), each with its own units. What no unit sees is the
// ASSEMBLED path: ONE value written through a real DOOR, carried through
// approve's direct Prisma write onto the work item, and read back out of the
// review model a reviewer opens. This file drives that chain, door by door,
// against the real database, and asserts the container refusal at every write
// door (the plan unchanged after).
//
// It does not re-enumerate what the feature cards already pin. Where a case
// below resembles a unit, the difference is the DRIVER — the unit calls
// `plansService` with a hand-built input, this calls the tool / route a real
// agent or person calls and follows the value to the row. Case → where it is
// held:
//
//   MCP append → get_plan → approve → row (each member) .... HERE
//   absent → NULL .......................................... HERE (MCP), and
//                     `proposedDifficulty.test.ts` (service)
//   deepen set / clear → approve ........................... HERE
//   correct low → medium → approve ......................... HERE
//   modify medium → high → approve, ONE revision ........... HERE (MCP); the
//                     service-level twin is `proposedDifficulty.test.ts`
//   internal route → approve ............................... HERE; the route's
//                     own parsing (set / absent / null / modifyPatch) is
//                     `tests/integration/ai/planRevisionRoutes.test.ts`
//   human proposal edit → persists → approve ............... HERE; its
//                     set / clear / off-scale are `publicProposalPatchDifficulty`
//   container refusal, MCP append add / modify / deepen kind flip /
//                     correction, internal route, human route ... HERE, all six
//   approve-time `difficulty_on_container` via change_kind .. HERE (the
//                     service twin re-kinds through the column)
//   review DTO read-back on add / modify / story ........... HERE on one plan;
//                     every op × value is `planReviewDifficulty.test.ts`
//   authored-bug seam (high lands + activity; null / absent
//                     keep a value) ............................ HELD by
//                     `tests/integration/monitors/monitorBugAuthoringApply.test.ts`
//                     ("the DIFFICULTY rides the same gated write"), which
//                     drives `monitorBugEnrichmentService.applyAuthoredBug`
//                     on real Postgres with only the motir-ai client stubbed;
//                     `tests/ai/authoredBug.test.ts` holds the parser.
//
// Mocks: the session (the one CLAUDE.md allows) and its workspace-context twin
// for the human route, the carve-out `publicProposalPatchTodos.test.ts`
// documents — `getWorkspaceContext` reads a cookie jar that does not exist
// outside a request. Everything else is real.
// ════════════════════════════════════════════════════════════════════════════

const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (activeCtx.current ? { user: { id: activeCtx.current.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));

const { PATCH: humanPATCH } = await import('@/app/api/plans/[id]/items/[itemId]/route');
const { PATCH: internalPATCH } =
  await import('@/app/api/internal/ai/plan-proposals/[itemId]/route');

const SERVICE_SECRET = 'core-callback-secret-test';

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  activeCtx.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the doors ───────────────────────────────────────────────────────────────

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-difficulty-story-gate', version: '0.0.0' });
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
  const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Difficulty, end to end',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  expect(opened.isError).toBeFalsy();
  return struct(opened).id;
}

async function append(client: Client, planId: string, proposals: unknown[]) {
  return call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals });
}

function internalPatch(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  const req = new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set(
    'x-motir-job-token',
    mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  );
  return internalPATCH(req, { params: Promise.resolve({ itemId }) });
}

function humanPatch(
  fx: WorkItemFixture,
  planId: string,
  itemId: string,
  body: unknown,
): Promise<Response> {
  activeCtx.current = {
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  } as ProjectContext;
  return humanPATCH(
    new Request(`http://core/api/plans/${planId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: planId, itemId }) },
  );
}

async function closeAndApprove(fx: WorkItemFixture, planId: string): Promise<void> {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.status !== 'planned') await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
}

async function rowNamed(fx: WorkItemFixture, title: string) {
  return adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId, title } });
}

/** A snapshot of everything a refused write could have touched. */
async function planState(planId: string) {
  const items = await adminDb.planItem.findMany({
    where: { planId },
    orderBy: { id: 'asc' },
    select: { id: true, op: true, proposedFields: true, patch: true },
  });
  return items;
}

// ── MCP append → get_plan → approve → work item ─────────────────────────────

describe('MCP append → get_plan → approve → the work item', () => {
  it('every member of the scale survives onto the created subtask; an add with none lands NULL', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await createTestWorkItem(fx, { kind: 'story', title: 'The parent story' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await append(client, planId, [
      ...WORK_ITEM_DIFFICULTIES.map((difficulty) => ({
        op: 'add',
        parentRef: parent.identifier,
        proposedFields: { title: `leaf-${difficulty}`, kind: 'subtask', difficulty },
      })),
      {
        op: 'add',
        parentRef: parent.identifier,
        proposedFields: { title: 'leaf-unjudged', kind: 'subtask' },
      },
    ]);
    expect(appended.isError).toBeFalsy();

    // The agent's read-back — the value, not just the call's success.
    const read = await call(client, GET_PLAN_TOOL_NAME, { planId });
    const byTitle = new Map(struct(read).items.map((i) => [i.proposedFields!.title, i]));
    for (const d of WORK_ITEM_DIFFICULTIES) {
      expect(byTitle.get(`leaf-${d}`)!.proposedFields!.difficulty).toBe(d);
    }
    expect(byTitle.get('leaf-unjudged')!.proposedFields).not.toHaveProperty('difficulty');

    await closeAndApprove(fx, planId);

    for (const d of WORK_ITEM_DIFFICULTIES) {
      const row = await rowNamed(fx, `leaf-${d}`);
      expect(row.kind).toBe('subtask');
      expect(row.parentId).toBe(parent.id);
      expect(row.difficulty).toBe(d);
    }
    expect((await rowNamed(fx, 'leaf-unjudged')).difficulty).toBeNull();
    await client.close();
  });
});

// ── deepen / correct → approve ──────────────────────────────────────────────

describe('update_plan_item (deepen) → approve', () => {
  it('a title-only add deepened to `high` lands `high`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const planItemId = ids(
      await append(client, planId, [{ op: 'add', proposedFields: { title: 'Deepened' } }]),
    )[0]!;

    const set = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      difficulty: 'high',
    });
    expect(set.isError).toBeFalsy();
    await closeAndApprove(fx, planId);

    expect((await rowNamed(fx, 'Deepened')).difficulty).toBe('high');
    await client.close();
  });

  it('a deepen that sends `null` clears it, and approve writes NULL', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const planItemId = ids(
      await append(client, planId, [
        { op: 'add', proposedFields: { title: 'Cleared', kind: 'task', difficulty: 'high' } },
      ]),
    )[0]!;

    const cleared = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      difficulty: null,
    });
    expect(cleared.isError).toBeFalsy();
    await closeAndApprove(fx, planId);

    expect((await rowNamed(fx, 'Cleared')).difficulty).toBeNull();
    await client.close();
  });
});

describe('update_plan_proposal (correct) → approve', () => {
  it('a `planned` plan’s add corrected from `low` to `medium` lands `medium`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const planItemId = ids(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId,
        proposals: [
          { op: 'add', proposedFields: { title: 'Corrected', kind: 'task', difficulty: 'low' } },
        ],
        final: true,
      }),
    )[0]!;
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId,
      difficulty: 'medium',
    });
    expect(corrected.isError).toBeFalsy();
    await closeAndApprove(fx, planId);

    expect((await rowNamed(fx, 'Corrected')).difficulty).toBe('medium');
    await client.close();
  });
});

// ── modify + the review DTO, on ONE plan ────────────────────────────────────

describe('a mixed plan: review DTO read-back, then approve onto the target', () => {
  it('the review carries the add’s value, the modify’s medium → high row, none on the story; approve writes high with ONE revision', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await createTestWorkItem(fx, { kind: 'story', title: 'Home story' });
    const target = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Committed leaf',
      parentId: parent.id,
    });
    await adminDb.workItem.update({ where: { id: target.id }, data: { difficulty: 'medium' } });
    const revisionsBefore = await adminDb.workItemRevision.count({
      where: { workItemId: target.id },
    });

    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await append(client, planId, [
      {
        op: 'add',
        parentRef: parent.identifier,
        proposedFields: { title: 'New leaf', kind: 'subtask', difficulty: 'trivial' },
      },
      { op: 'add', proposedFields: { title: 'New story', kind: 'story' } },
      { op: 'modify', workItemId: target.id, patch: { difficulty: 'high' } },
    ]);
    expect(appended.isError).toBeFalsy();
    await plansService.markPlanned(planId, fx.ctx);

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const add = review.items.find((i) => i.op === 'add' && i.title === 'New leaf')!;
    const story = review.items.find((i) => i.op === 'add' && i.title === 'New story')!;
    const modify = review.items.find((i) => i.op === 'modify')!;

    expect(add.difficulty).toBe('trivial');
    expect(add.changes.filter((c) => c.field === 'difficulty')).toEqual([]);
    expect(story.difficulty).toBeNull();
    expect(modify.difficulty).toBe('high');
    expect(modify.changes.filter((c) => c.field === 'difficulty')).toEqual([
      { field: 'difficulty', from: 'medium', to: 'high' },
    ]);
    expect(modify.proposal.changedFields).toContain('difficulty');

    await plansService.approvePlan(planId, fx.ctx);

    expect((await rowNamed(fx, 'New leaf')).difficulty).toBe('trivial');
    expect((await rowNamed(fx, 'New story')).difficulty).toBeNull();
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.difficulty).toBe('high');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: target.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(revisions).toHaveLength(revisionsBefore + 1);
    const moved = revisions.filter(
      (r) => r.diff !== null && typeof r.diff === 'object' && 'difficulty' in r.diff,
    );
    expect(moved.map((r) => (r.diff as Record<string, unknown>)['difficulty'])).toEqual([
      { from: 'medium', to: 'high' },
    ]);
    await client.close();
  });
});

// ── the internal route and the human route → approve ────────────────────────

describe('the internal route motir-ai writes through → approve', () => {
  it('a job-token PATCH with patch.difficulty `low` on a generating plan lands `low`', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Hosted planner', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Via motir-ai', kind: 'task' } }],
      fx.ctx,
    );
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-6141' } });

    const res = await internalPatch(fx, appended.items[0]!.id, {
      jobId: 'job-6141',
      patch: { difficulty: 'low' },
    });
    expect(res.status).toBe(200);
    await closeAndApprove(fx, plan.id);

    expect((await rowNamed(fx, 'Via motir-ai')).difficulty).toBe('low');
  });
});

describe('the human proposal-edit route → approve', () => {
  it('a session PATCH with difficulty `medium` persists on the proposal and lands on the row', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Edited' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Via a person', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const itemId = appended.items[0]!.id;

    const res = await humanPatch(fx, plan.id, itemId, { difficulty: 'medium' });
    expect(res.status).toBe(200);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(stored.proposedFields).toMatchObject({ difficulty: 'medium' });

    await plansService.approvePlan(plan.id, fx.ctx);
    expect((await rowNamed(fx, 'Via a person')).difficulty).toBe('medium');
  });
});

// ── the container refusal at EVERY write door ───────────────────────────────

describe('a difficulty on a CONTAINER is refused at every write door, and writes nothing', () => {
  it('MCP append: a `story` add, and a `modify` of an epic — INVALID_PROPOSAL naming `difficulty`', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'An epic' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const onStoryAdd = await append(client, planId, [
      { op: 'add', proposedFields: { title: 'A story', kind: 'story', difficulty: 'low' } },
    ]);
    const onEpicModify = await append(client, planId, [
      { op: 'modify', workItemId: epic.id, patch: { difficulty: 'high' } },
    ]);
    for (const refused of [onStoryAdd, onEpicModify]) {
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('INVALID_PROPOSAL');
      expect(text(refused)).toContain('difficulty');
    }
    expect(await planState(planId)).toEqual([]);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: epic.id } })).difficulty,
    ).toBeNull();
    await client.close();
  });

  it('update_plan_item: flipping `kind` to `story` while a value is set', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const planItemId = ids(
      await append(client, planId, [
        { op: 'add', proposedFields: { title: 'Leaf', kind: 'task', difficulty: 'medium' } },
      ]),
    )[0]!;
    const before = await planState(planId);

    const flipped = await call(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId,
      kind: 'story',
    });
    expect(flipped.isError).toBe(true);
    expect(text(flipped)).toContain('INVALID_PROPOSAL');
    expect(text(flipped)).toContain('difficulty');
    expect(await planState(planId)).toEqual(before);
    await client.close();
  });

  it('update_plan_proposal: a value set on a `planned` story add', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const planItemId = ids(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId,
        proposals: [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
        final: true,
      }),
    )[0]!;
    const before = await planState(planId);

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId,
      difficulty: 'high',
    });
    expect(corrected.isError).toBe(true);
    expect(text(corrected)).toContain('INVALID_PROPOSAL');
    expect(text(corrected)).toContain('difficulty');
    expect(await planState(planId)).toEqual(before);
    await client.close();
  });

  it('the internal route: 422 INVALID_PROPOSAL naming `difficulty`', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Hosted planner', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
      fx.ctx,
    );
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-6141-bad' } });
    const before = await planState(plan.id);

    const res = await internalPatch(fx, appended.items[0]!.id, {
      jobId: 'job-6141-bad',
      patch: { difficulty: 'low' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('difficulty');
    expect(await planState(plan.id)).toEqual(before);
  });

  it('the human route: 422 INVALID_PROPOSAL naming `difficulty`', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Edited' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'An epic', kind: 'epic' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const before = await planState(plan.id);

    const res = await humanPatch(fx, plan.id, appended.items[0]!.id, { difficulty: 'high' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_PROPOSAL');
    expect(body.error).toContain('difficulty');
    expect(await planState(plan.id)).toEqual(before);
  });
});

// ── the approve-time refusal ────────────────────────────────────────────────

describe('approve refuses a difficulty whose modify target became a container', () => {
  it('a target re-kinded to `story` through change_kind after the append → difficulty_on_container, nothing materializes', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'A leaf, for now' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);
    const appended = await append(client, planId, [
      { op: 'add', proposedFields: { title: 'A sibling', kind: 'task', difficulty: 'low' } },
      { op: 'modify', workItemId: target.id, patch: { difficulty: 'high' } },
    ]);
    expect(appended.isError).toBeFalsy();
    await plansService.markPlanned(planId, fx.ctx);

    // The world moves between the close and the button — through the real tool.
    const rekinded = await call(client, CHANGE_KIND_TOOL_NAME, {
      key: target.identifier,
      kind: 'story',
    });
    expect(rekinded.isError).toBeFalsy();

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((err as PlanGrammarError).reason).toBe('difficulty_on_container');

    expect(
      await adminDb.workItem.count({ where: { projectId: fx.projectId, title: 'A sibling' } }),
    ).toBe(0);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.kind).toBe('story');
    expect(after.difficulty).toBeNull();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    await client.close();
  });
});
