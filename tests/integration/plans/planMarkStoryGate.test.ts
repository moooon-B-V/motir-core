import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { mintJobToken } from '@/lib/ai/jobToken';
import {
  PLAN_ITEM_MARK_PATCH_KEYS,
  PLAN_ITEM_PATCH_KEYS,
  type PlanItemPatch,
  type ProposalInput,
} from '@/lib/dto/plans';
import {
  PATCH_KEY_RAIL_ROW,
  PLAN_ITEM_MARK_CHANGE_FIELDS,
  type PlanReviewItemDto,
} from '@/lib/dto/planReview';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ════════════════════════════════════════════════════════════════════════════
// STORY GATE — the motir-core side of MOTIR-6577 (Subtask MOTIR-6633).
//
// Five motir-core cards built "a plan MARKS a card": the mark and its note on a
// `modify` (MOTIR-6629), the `supersedes` edge carriers (MOTIR-6630), the
// finished-card-only rule (MOTIR-6663), the plan DOORS (MOTIR-6631) and the review
// render (MOTIR-6632). Each shipped its own tests, and each drives ITS layer with
// a hand-built input. What none of them sees is the ASSEMBLED path: a mark, a note
// and each supersedes carrier written through a real DOOR, read back out of the
// review model BEFORE approve, and found on the work items AFTER it — and the
// same refusal answered with the same code whichever door sent it.
//
// THE DOORS. Five write paths reach a proposal's mark keys:
//   · MCP `add_plan_items` (resolves KEYS on all five carriers)
//   · the INTERNAL append route motir-ai writes through (ids / `planItem:` only)
//   · MCP `update_plan_proposal` (the correction; replaces a `modify`'s patch)
//   · the INTERNAL correct route (`mode: 'correct'`, `modifyPatch`)
//   · the HUMAN proposal-edit route (an `add`'s `supersedesRefs` only)
//
// ⚠️ THE HUMAN ROUTE'S EMPTY CELLS ARE AN INVARIANT, NOT A GAP. That route edits
// `add`s and reads no mark key (`app/api/plans/[id]/items/[itemId]/route.ts`: "This
// route edits `add`s only, so it takes no mark key"), so an unknown mark, a
// non-mark key on a `done` target and the finished-card rule — all properties of a
// `modify`'s patch — cannot arrive through it. Its row of the refusal matrix is
// the three refusals an `add`'s `supersedesRefs` CAN carry: a dangling ref, a
// `planItem:` ref naming no add, and a supersedes cycle through a live link.
//
// THE SAME-BATCH CELL. A `planItem:` ref naming an `add` of the SAME call exists
// only at the two APPEND doors; a correction has no batch. Its correction-door
// twin is a `planItem:` ref naming no add of the plan (`UNRESOLVED_PLAN_REF`).
//
// Case → where it is held:
//   door → review → approve → row, per door ............... HERE, five doors
//   terminal card (done, cancelled), rollup ON, no status
//     move on the card or its parent ....................... HERE, through the
//                     real event path (`sendEvent` pumped into the rollup)
//   one row, two spellings ............................... HERE (internal append)
//   refusals × doors ..................................... HERE
//   contract guard over the four key lists ............... HERE
//   the unit-level shape of each refusal message ......... `proposedObsolescence`,
//                     `proposedSupersedes`, `tests/mcp/plan-obsolescence`
//
// Mocks: the session and its workspace-context twin for the human route (the
// carve-out `planDifficultyStoryGate.test.ts` documents), and `sendEvent`, whose
// queue is played through the real rollup service exactly as
// `tests/integration/workflows/statusDerivation.test.ts` pumps it. Everything
// else — Postgres, the MCP server, the routes, job-token auth — is real.
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

interface Emitted {
  name: string;
  data: { workItemId: string; workspaceId: string; parentIds?: string[]; parentId?: string };
}
const queue: Emitted[] = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    queue.push({ name, data: data as Emitted['data'] });
  },
}));

/** Play every queued event through the rollup consumers `lib/jobs/registry.ts`
 *  routes it to. Returns the event names played, so a test can say WHAT ran. */
async function drainRollup(): Promise<string[]> {
  const played: string[] = [];
  let steps = 0;
  while (queue.length > 0) {
    if (++steps > 40) throw new Error('rollup pump did not terminate');
    const event = queue.shift()!;
    played.push(event.name);
    if (event.name === 'work-item/transitioned' || event.name === 'work-item/created') {
      await parentStatusRollupService.rollUpForChild(event.data.workItemId, event.data.workspaceId);
    } else if (event.name === 'work-item/child-set.changed') {
      for (const parentId of event.data.parentIds ?? []) {
        await parentStatusRollupService.recomputeParent(parentId, event.data.workspaceId);
      }
    }
  }
  return played;
}

const { PATCH: humanPATCH } = await import('@/app/api/plans/[id]/items/[itemId]/route');
const { POST: internalPOST } = await import('@/app/api/internal/ai/plan-proposals/route');
const { PATCH: internalPATCH } =
  await import('@/app/api/internal/ai/plan-proposals/[itemId]/route');

const SERVICE_SECRET = 'core-callback-secret-test';

const ids = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
const text = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  activeCtx.current = null;
  queue.length = 0;
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
  const client = new Client({ name: 'plan-mark-story-gate', version: '0.0.0' });
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

async function openMcpPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const opened = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Marks a card, end to end',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  expect(opened.isError).toBeFalsy();
  return (opened.structuredContent as unknown as { id: string }).id;
}

function withJobToken(fx: WorkItemFixture, req: Request): Request {
  req.headers.set(
    'x-motir-job-token',
    mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  );
  return req;
}

function internalAppend(fx: WorkItemFixture, body: unknown): Promise<Response> {
  return internalPOST(
    withJobToken(
      fx,
      new Request('http://core/api/internal/ai/plan-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
        body: JSON.stringify(body),
      }),
    ),
  );
}

function internalCorrect(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  return internalPATCH(
    withJobToken(
      fx,
      new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
        body: JSON.stringify(body),
      }),
    ),
    { params: Promise.resolve({ itemId }) },
  );
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

/** A plan motir-ai owns — bound to `jobId`, `generating`, native author. */
async function jobPlan(fx: WorkItemFixture, jobId: string): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Hosted planner', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return plan.id;
}

async function servicePlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Reviewed' }, fx.ctx)).id;
}

/** Append through the service, one call per batch so each `add`'s id is refable. */
async function seed(fx: WorkItemFixture, planId: string, ...batches: ProposalInput[][]) {
  const out: string[] = [];
  for (const batch of batches) {
    out.push(...(await plansService.addProposals(planId, batch, fx.ctx)).appendedItemIds);
  }
  return out;
}

async function close(fx: WorkItemFixture, planId: string): Promise<void> {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.status !== 'planned') await plansService.markPlanned(planId, fx.ctx);
}

async function review(fx: WorkItemFixture, planId: string, planItemId: string) {
  const r = await planReviewService.getPlanReview(planId, fx.ctx);
  return r.items.find((i) => i.planItemId === planItemId)!;
}

/** The review's MARK rows for one item, in the order the service emits them. */
function markRows(item: PlanReviewItemDto) {
  return item.changes.filter((c) =>
    (PLAN_ITEM_MARK_CHANGE_FIELDS as readonly string[]).includes(c.field),
  );
}

async function doneCard(fx: WorkItemFixture, title: string, status = 'done') {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
  return item;
}

async function liveSupersedes(fx: WorkItemFixture, fromId: string, toId: string) {
  await adminDb.workItemLink.create({
    data: {
      workspaceId: fx.ctx.workspaceId,
      fromId,
      toId,
      kind: 'supersedes',
      createdById: fx.ctx.userId,
    },
  });
}

async function supersedesRows(fx: WorkItemFixture) {
  const rows = await adminDb.workItemLink.findMany({
    where: { workspaceId: fx.ctx.workspaceId, kind: 'supersedes' },
    select: { fromId: true, toId: true },
  });
  return rows.map((r) => `${r.fromId}->${r.toId}`).sort();
}

const edge = (fromId: string, toId: string) => `${fromId}->${toId}`;

async function createdFrom(planItemId: string): Promise<string> {
  return (await adminDb.planItem.findUniqueOrThrow({ where: { id: planItemId } })).workItemId!;
}

const row = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

/** Everything a refused write could have touched on the plan. */
async function planState(planId: string) {
  return adminDb.planItem.findMany({
    where: { planId },
    orderBy: { id: 'asc' },
    select: { id: true, op: true, patch: true, supersedesRefs: true, proposedFields: true },
  });
}

/** One refusal, the same shape whichever door answered it. `reason` rides the
 *  HTTP doors as data; the MCP doors carry only `CODE: message`. */
interface Refusal {
  code: string;
  reason?: string;
  message: string;
}

/**
 * A tool error's code: the leading `CODE:` a service refusal carries
 * (`toolError`), or — when the tool's input SCHEMA answers first and the SDK
 * wraps it as `MCP error -32602: …` — the `CODE:` its message was written with
 * (the `obsolescence` enum's `errorMap` spells `INVALID_PROPOSAL: …`).
 */
function mcpRefusal(r: CallToolResult): Refusal {
  expect(r.isError).toBe(true);
  const t = text(r);
  const code = /\b([A-Z][A-Z_]{4,}):/.exec(t)?.[1] ?? t;
  return { code, message: t };
}

async function httpRefusal(res: Response, status = 422): Promise<Refusal> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { code: string; reason?: string; error: string };
  return {
    code: body.code,
    ...(body.reason ? { reason: body.reason } : {}),
    message: body.error,
  };
}

/** The refusal a plan meets between the close and the approve button. */
async function refusalOnTheWay(fx: WorkItemFixture, planId: string): Promise<Refusal> {
  const err = await close(fx, planId)
    .then(() => plansService.approvePlan(planId, fx.ctx))
    .then(() => null)
    .catch((e: unknown) => e);
  expect(err).not.toBeNull();
  const e = err as { code: string; reason?: string; message: string };
  return { code: e.code, ...(e.reason ? { reason: e.reason } : {}), message: e.message };
}

const FINISHED_ONLY = 'a plan may mark only a finished work item';

// ════════════════════════════════════════════════════════════════════════════
// Door → review → approve → the work items, one door at a time
// ════════════════════════════════════════════════════════════════════════════

describe('door → review → approve → the work items', () => {
  it('MCP add_plan_items: an add’s supersedesRefs by KEY and a mark-only modify by `planItem:` ref', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneCard(fx, 'Deliver webhooks at most once');
    const client = await connectClient(fx.ctx);
    const planId = await openMcpPlan(client, fx);

    const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Deliver webhooks exactly once', kind: 'task' },
          supersedesRefs: [old.identifier],
        },
      ],
    });
    expect(first.isError).toBeFalsy();
    const addId = ids(first)[0]!;
    const note = 'Delivery is exactly-once now.\nRead the new card.';
    const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: old.id,
          patch: { obsolescence: 'outdated', obsolescenceNoteMd: note },
        },
      ],
      final: true,
    });
    expect(second.isError).toBeFalsy();
    const modifyId = ids(second)[0]!;

    // BEFORE approve: the review shows exactly what approve will write.
    const add = await review(fx, planId, addId);
    expect(add.supersedesRefs).toEqual([
      {
        identifier: old.identifier,
        title: 'Deliver webhooks at most once',
        kind: 'task',
        proposed: false,
      },
    ]);
    const modify = await review(fx, planId, modifyId);
    expect(markRows(modify)).toEqual([
      { field: 'obsolescence', from: 'current', to: 'outdated' },
      { field: 'obsolescenceNote', from: null, to: note },
    ]);
    expect(modify.changes.some((c) => c.field === 'status')).toBe(false);

    await plansService.approvePlan(planId, fx.ctx);

    const created = await createdFrom(addId);
    const after = await row(old.id);
    expect(after.obsolescence).toBe('outdated');
    expect(after.obsolescenceNoteMd).toBe(note);
    expect(after.status).toBe('done');
    expect(await supersedesRows(fx)).toEqual([edge(created, old.id)]);
    await client.close();
  });

  it('the INTERNAL append route: deprecated + note, supersedesAdd a done card, supersededByRemove a live link', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Poll the bank feed');
    const older = await doneCard(fx, 'Poll every ten minutes');
    const newer = await doneCard(fx, 'A replacement that was reverted');
    await liveSupersedes(fx, newer.id, target.id);
    const planId = await jobPlan(fx, 'job-6633-append');

    const res = await internalAppend(fx, {
      jobId: 'job-6633-append',
      final: true,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: {
            obsolescence: 'deprecated',
            obsolescenceNoteMd: 'Overturned: the bank pushes events now.',
            supersedesAdd: [older.id],
            supersededByRemove: [newer.id],
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    const modifyId = ((await res.json()) as { planItemIds: string[] }).planItemIds[0]!;

    const item = await review(fx, planId, modifyId);
    const rows = markRows(item);
    expect(rows.map((r) => r.field)).toEqual([
      'obsolescence',
      'obsolescenceNote',
      'supersedes',
      'supersededBy',
    ]);
    expect(rows[0]).toEqual({ field: 'obsolescence', from: 'current', to: 'deprecated' });
    expect(rows[2]!.refs).toEqual({
      added: [
        {
          identifier: older.identifier,
          title: 'Poll every ten minutes',
          kind: 'task',
          proposed: false,
        },
      ],
      removed: [],
    });
    expect(rows[3]!.refs).toEqual({
      added: [],
      removed: [
        {
          identifier: newer.identifier,
          title: 'A replacement that was reverted',
          kind: 'task',
          proposed: false,
        },
      ],
    });

    await plansService.approvePlan(planId, fx.ctx);

    const after = await row(target.id);
    expect(after.obsolescence).toBe('deprecated');
    expect(after.obsolescenceNoteMd).toBe('Overturned: the bank pushes events now.');
    expect(after.status).toBe('done');
    expect(await supersedesRows(fx)).toEqual([edge(target.id, older.id)]);
  });

  it('MCP update_plan_proposal: corrects an add’s supersedesRefs and a modify’s patch by KEY', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Retry three times');
    const replaced = await doneCard(fx, 'Retry once');
    const dropped = await doneCard(fx, 'Retry forever');
    await liveSupersedes(fx, target.id, dropped.id);
    const client = await connectClient(fx.ctx);
    const planId = await openMcpPlan(client, fx);
    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'Retry with backoff', kind: 'task' } },
        { op: 'modify', workItemId: target.id, patch: { obsolescence: 'outdated' } },
      ],
      final: true,
    });
    expect(appended.isError).toBeFalsy();
    const [addId, modifyId] = ids(appended) as [string, string];

    const onAdd = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId,
      supersedesRefs: [replaced.identifier],
    });
    expect(onAdd.isError).toBeFalsy();
    const onModify = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: {
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Backoff replaces fixed retries.',
        supersedesRemove: [dropped.identifier],
      },
    });
    expect(onModify.isError).toBeFalsy();

    expect((await review(fx, planId, addId)).supersedesRefs).toEqual([
      { identifier: replaced.identifier, title: 'Retry once', kind: 'task', proposed: false },
    ]);
    const modify = await review(fx, planId, modifyId);
    expect(
      markRows(modify).map((r) => [r.field, r.from, r.field === 'supersedes' ? r.refs : r.to]),
    ).toEqual([
      ['obsolescence', 'current', 'deprecated'],
      ['obsolescenceNote', null, 'Backoff replaces fixed retries.'],
      [
        'supersedes',
        null,
        {
          added: [],
          removed: [
            {
              identifier: dropped.identifier,
              title: 'Retry forever',
              kind: 'task',
              proposed: false,
            },
          ],
        },
      ],
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const created = await createdFrom(addId);
    const after = await row(target.id);
    expect(after.obsolescence).toBe('deprecated');
    expect(after.obsolescenceNoteMd).toBe('Backoff replaces fixed retries.');
    expect(await supersedesRows(fx)).toEqual([edge(created, replaced.id)]);
    await client.close();
  });

  it('the INTERNAL correct route: a CANCELLED card’s modifyPatch and an add’s supersedesRefs', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Sign payloads with HMAC-SHA1', 'cancelled');
    const alsoReplaced = await doneCard(fx, 'Rotate the SHA1 key yearly');
    const planId = await jobPlan(fx, 'job-6633-correct');
    const [addId, modifyId] = await seed(
      fx,
      planId,
      [{ op: 'add', proposedFields: { title: 'Sign payloads with Ed25519', kind: 'task' } }],
      [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'deprecated' } }],
    );
    await close(fx, planId);

    const onModify = await internalCorrect(fx, modifyId!, {
      jobId: 'job-6633-correct',
      mode: 'correct',
      modifyPatch: {
        obsolescence: 'outdated',
        obsolescenceNoteMd: 'Ed25519 replaced it.',
        supersededByAdd: [`planItem:${addId}`],
      },
    });
    expect(onModify.status).toBe(200);
    const onAdd = await internalCorrect(fx, addId!, {
      jobId: 'job-6633-correct',
      mode: 'correct',
      supersedesRefs: [alsoReplaced.id],
    });
    expect(onAdd.status).toBe(200);

    const modify = await review(fx, planId, modifyId!);
    const rows = markRows(modify);
    expect(rows.slice(0, 2)).toEqual([
      { field: 'obsolescence', from: 'current', to: 'outdated' },
      { field: 'obsolescenceNote', from: null, to: 'Ed25519 replaced it.' },
    ]);
    expect(rows[2]!.field).toBe('supersededBy');
    expect(rows[2]!.refs!.added).toEqual([
      {
        identifier: null,
        title: 'Sign payloads with Ed25519',
        kind: 'task',
        proposed: true,
        planItemId: addId,
      },
    ]);
    expect((await review(fx, planId, addId!)).supersedesRefs!.map((c) => c.identifier)).toEqual([
      alsoReplaced.identifier,
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const created = await createdFrom(addId!);
    const after = await row(target.id);
    expect(after.obsolescence).toBe('outdated');
    expect(after.status).toBe('cancelled');
    expect(await supersedesRows(fx)).toEqual(
      [edge(created, target.id), edge(created, alsoReplaced.id)].sort(),
    );
  });

  it('the HUMAN proposal-edit route: an add’s supersedesRefs, set by a person', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneCard(fx, 'Export as CSV');
    const planId = await servicePlan(fx);
    const [addId] = await seed(fx, planId, [
      { op: 'add', proposedFields: { title: 'Export as Parquet', kind: 'task' } },
    ]);
    await close(fx, planId);

    const res = await humanPatch(fx, planId, addId!, { supersedesRefs: [old.id] });
    expect(res.status).toBe(200);

    expect((await review(fx, planId, addId!)).supersedesRefs).toEqual([
      { identifier: old.identifier, title: 'Export as CSV', kind: 'task', proposed: false },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    expect(await supersedesRows(fx)).toEqual([edge(await createdFrom(addId!), old.id)]);
    // An `add`'s edge marks nothing: the older card keeps its standing.
    expect((await row(old.id)).obsolescence).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// One row, two spellings
// ════════════════════════════════════════════════════════════════════════════

describe('one edge spelled from both ends lands ONE row', () => {
  it('supersededByAdd on the old card + supersedesRefs on the new add, through the internal append', async () => {
    const fx = await makeWorkItemFixture();
    const old = await doneCard(fx, 'The old contract');
    const planId = await jobPlan(fx, 'job-6633-one-row');

    const first = await internalAppend(fx, {
      jobId: 'job-6633-one-row',
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'The new contract', kind: 'task' },
          supersedesRefs: [old.id],
        },
      ],
    });
    expect(first.status).toBe(200);
    const addId = ((await first.json()) as { planItemIds: string[] }).planItemIds[0]!;
    const second = await internalAppend(fx, {
      jobId: 'job-6633-one-row',
      final: true,
      proposals: [
        {
          op: 'modify',
          workItemId: old.id,
          patch: { obsolescence: 'outdated', supersededByAdd: [`planItem:${addId}`] },
        },
      ],
    });
    expect(second.status).toBe(200);

    await plansService.approvePlan(planId, fx.ctx);

    const created = await createdFrom(addId);
    expect(await supersedesRows(fx)).toEqual([edge(created, old.id)]);
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: created, toId: old.id, kind: 'supersedes' },
      }),
    ).toBe(1);
    expect((await row(old.id)).obsolescence).toBe('outdated');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The terminal card, with the parent rollup ON
// ════════════════════════════════════════════════════════════════════════════

describe('a mark-only modify of a terminal card moves neither it nor its parent', () => {
  it.each(['done', 'cancelled'])(
    'a `%s` card: approve writes the mark and the link; status and parent stay, rollup ON',
    async (status) => {
      const fx = await makeWorkItemFixture();
      await adminDb.project.update({
        where: { id: fx.projectId },
        data: { autoRollupParentStatus: true },
      });
      const parent = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
      await adminDb.workItem.update({ where: { id: parent.id }, data: { status: 'in_progress' } });
      const target = await createTestWorkItem(fx, {
        kind: 'subtask',
        title: 'Finished leaf',
        parentId: parent.id,
      });
      await adminDb.workItem.update({ where: { id: target.id }, data: { status } });
      // A sibling in review: with the target finished, EVERY child is in review or
      // done — so a recompute of the parent WOULD move it off `in_progress`. That is
      // what keeps "the parent did not move" from passing vacuously.
      const sibling = await createTestWorkItem(fx, {
        kind: 'subtask',
        title: 'Sibling in review',
        parentId: parent.id,
      });
      await adminDb.workItem.update({ where: { id: sibling.id }, data: { status: 'in_review' } });
      const replacement = await doneCard(fx, 'The replacing card');
      queue.length = 0;

      const client = await connectClient(fx.ctx);
      const planId = await openMcpPlan(client, fx);
      const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId,
        proposals: [
          {
            op: 'modify',
            workItemId: target.id,
            patch: {
              obsolescence: 'deprecated',
              obsolescenceNoteMd: 'Retired.',
              supersededByAdd: [replacement.identifier],
            },
          },
        ],
        final: true,
      });
      expect(appended.isError).toBeFalsy();
      await plansService.approvePlan(planId, fx.ctx);
      const played = await drainRollup();

      const after = await row(target.id);
      expect(after.obsolescence).toBe('deprecated');
      expect(after.status).toBe(status);
      expect(await supersedesRows(fx)).toEqual([edge(replacement.id, target.id)]);
      expect((await row(parent.id)).status).toBe('in_progress');
      // Approve announced no status change for the target.
      expect(played).not.toContain('work-item/transitioned');

      // The control: the toggle is live and a recompute WOULD have moved the parent.
      await parentStatusRollupService.recomputeParent(parent.id, fx.ctx.workspaceId);
      expect((await row(parent.id)).status).not.toBe('in_progress');
      await client.close();
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Refusals at every door
// ════════════════════════════════════════════════════════════════════════════

describe('an UNKNOWN mark is INVALID_PROPOSAL at every door that carries a patch', () => {
  it('MCP append, internal append, update_plan_proposal, internal correct', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Target');
    const client = await connectClient(fx.ctx);

    const mcpPlan = await openMcpPlan(client, fx);
    const viaMcpAppend = mcpRefusal(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: mcpPlan,
        proposals: [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'stale' } }],
      }),
    );
    expect(await planState(mcpPlan)).toEqual([]);

    const jobPlanId = await jobPlan(fx, 'job-6633-unknown');
    const viaInternalAppend = await httpRefusal(
      await internalAppend(fx, {
        jobId: 'job-6633-unknown',
        proposals: [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'stale' } }],
      }),
    );
    expect(await planState(jobPlanId)).toEqual([]);

    const [modifyId] = await seed(fx, jobPlanId, [
      { op: 'modify', workItemId: target.id, patch: { obsolescence: 'outdated' } },
    ]);
    const before = await planState(jobPlanId);
    const viaMcpCorrect = mcpRefusal(
      await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId: jobPlanId,
        planItemId: modifyId,
        patch: { obsolescence: 'stale' },
      }),
    );
    const viaInternalCorrect = await httpRefusal(
      await internalCorrect(fx, modifyId!, {
        jobId: 'job-6633-unknown',
        mode: 'correct',
        modifyPatch: { obsolescence: 'stale' },
      }),
    );
    expect(await planState(jobPlanId)).toEqual(before);

    for (const r of [viaMcpAppend, viaInternalAppend, viaMcpCorrect, viaInternalCorrect]) {
      expect(r.code).toBe('INVALID_PROPOSAL');
      expect(r.message).toContain('obsolescence');
    }
    // The service's own sentence names the value where the service answers it.
    expect(viaInternalAppend.message).toContain('"stale" is not an obsolescence mark');
    expect(viaInternalCorrect.message).toContain('"stale" is not an obsolescence mark');
    await client.close();
  });
});

describe('a DANGLING supersedes ref is INVALID_PLAN_REF_GRAPH at every door', () => {
  it('all five doors, each naming the ref', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Target');
    const client = await connectClient(fx.ctx);
    const ghostKey = `${fx.projectIdentifier}-99999`;
    const ghostId = 'cm0000000000000000ghost00';

    const mcpPlan = await openMcpPlan(client, fx);
    const viaMcpAppend = mcpRefusal(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: mcpPlan,
        proposals: [
          { op: 'modify', workItemId: target.id, patch: { supersededByAdd: [ghostKey] } },
        ],
      }),
    );
    expect(viaMcpAppend.message).toContain(ghostKey);
    expect(await planState(mcpPlan)).toEqual([]);

    // The internal append resolves no keys: an id naming nothing is judged where
    // real ids are checked — at the close.
    const appendPlan = await jobPlan(fx, 'job-6633-dangling-append');
    const appended = await internalAppend(fx, {
      jobId: 'job-6633-dangling-append',
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Replaces a ghost', kind: 'task' },
          supersedesRefs: [ghostId],
        },
      ],
    });
    const viaInternalAppend =
      appended.status === 200 ? await refusalOnTheWay(fx, appendPlan) : await httpRefusal(appended);

    const correctPlan = await jobPlan(fx, 'job-6633-dangling-correct');
    const [addId, modifyId] = await seed(
      fx,
      correctPlan,
      [{ op: 'add', proposedFields: { title: 'A new card', kind: 'task' } }],
      [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'outdated' } }],
    );
    await close(fx, correctPlan);
    const before = await planState(correctPlan);
    const viaMcpCorrect = mcpRefusal(
      await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId: correctPlan,
        planItemId: modifyId,
        patch: { obsolescence: 'outdated', supersedesAdd: [ghostKey] },
      }),
    );
    const viaInternalCorrect = await httpRefusal(
      await internalCorrect(fx, modifyId!, {
        jobId: 'job-6633-dangling-correct',
        mode: 'correct',
        modifyPatch: { obsolescence: 'outdated', supersedesAdd: [ghostId] },
      }),
    );
    const viaHuman = await httpRefusal(
      await humanPatch(fx, correctPlan, addId!, { supersedesRefs: [ghostId] }),
    );
    expect(await planState(correctPlan)).toEqual(before);

    for (const r of [
      viaMcpAppend,
      viaInternalAppend,
      viaMcpCorrect,
      viaInternalCorrect,
      viaHuman,
    ]) {
      expect(r.code).toBe('INVALID_PLAN_REF_GRAPH');
    }
    for (const r of [viaInternalAppend, viaInternalCorrect, viaHuman]) {
      expect(r.reason).toBe('dangling');
      expect(r.message).toContain(ghostId);
    }
    expect(viaMcpCorrect.message).toContain(ghostKey);
    await client.close();
  });
});

describe('a `planItem:` ref naming no earlier add is refused at every door', () => {
  it('the SAME batch at the two append doors; no such add at the three correction doors', async () => {
    const fx = await makeWorkItemFixture();
    const target = await doneCard(fx, 'Target');
    const client = await connectClient(fx.ctx);

    // Same batch: the add is written by the SAME call that names it.
    const mcpPlan = await openMcpPlan(client, fx);
    const sameBatch = (planItemId: string) => [
      { op: 'add', proposedFields: { title: 'Sibling add', kind: 'task' } },
      {
        op: 'modify',
        workItemId: target.id,
        patch: { obsolescence: 'outdated', supersededByAdd: [`planItem:${planItemId}`] },
      },
    ];
    // An id that no call has returned yet is the only one a same-batch author can
    // hold; the append refuses it before it could name its sibling.
    const viaMcpAppend = mcpRefusal(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: mcpPlan,
        proposals: sameBatch('not-yet-written'),
      }),
    );
    expect(await planState(mcpPlan)).toEqual([]);
    const jobPlanId = await jobPlan(fx, 'job-6633-same-batch');
    const viaInternalAppend = await httpRefusal(
      await internalAppend(fx, {
        jobId: 'job-6633-same-batch',
        proposals: sameBatch('not-yet-written'),
      }),
    );
    expect(await planState(jobPlanId)).toEqual([]);
    for (const r of [viaMcpAppend, viaInternalAppend]) {
      expect(r.code).toBe('UNRESOLVED_PLAN_REF');
      expect(r.message).toContain('planItem:not-yet-written');
    }

    // Corrections: a `planItem:` ref naming no add of this plan.
    const [addId, modifyId] = await seed(
      fx,
      jobPlanId,
      [{ op: 'add', proposedFields: { title: 'A new card', kind: 'task' } }],
      [{ op: 'modify', workItemId: target.id, patch: { obsolescence: 'outdated' } }],
    );
    await close(fx, jobPlanId);
    const before = await planState(jobPlanId);
    const bogus = 'planItem:cm00000000000000000nothing';
    const viaMcpCorrect = mcpRefusal(
      await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId: jobPlanId,
        planItemId: modifyId,
        patch: { obsolescence: 'outdated', supersededByAdd: [bogus] },
      }),
    );
    const viaInternalCorrect = await httpRefusal(
      await internalCorrect(fx, modifyId!, {
        jobId: 'job-6633-same-batch',
        mode: 'correct',
        modifyPatch: { obsolescence: 'outdated', supersededByAdd: [bogus] },
      }),
    );
    const viaHuman = await httpRefusal(
      await humanPatch(fx, jobPlanId, addId!, { supersedesRefs: [bogus] }),
    );
    expect(await planState(jobPlanId)).toEqual(before);
    for (const r of [viaMcpCorrect, viaInternalCorrect, viaHuman]) {
      expect(r.code).toBe('UNRESOLVED_PLAN_REF');
      expect(r.message).toContain(bogus);
    }
    await client.close();
  });
});

describe('a supersedes CYCLE through a LIVE link is INVALID_PLAN_REF_GRAPH at every door', () => {
  it('all five doors', async () => {
    const fx = await makeWorkItemFixture();
    // Live: A supersedes B. Proposing "B supersedes A" closes the ring.
    const a = await doneCard(fx, 'A — the replacement');
    const b = await doneCard(fx, 'B — the replaced');
    await liveSupersedes(fx, a.id, b.id);
    const client = await connectClient(fx.ctx);
    const cycleOnB: PlanItemPatch = { obsolescence: 'outdated', supersedesAdd: [a.id] };

    const mcpPlan = await openMcpPlan(client, fx);
    const viaMcpAppend = mcpRefusal(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: mcpPlan,
        proposals: [
          {
            op: 'modify',
            workItemId: b.id,
            patch: { obsolescence: 'outdated', supersedesAdd: [a.identifier] },
          },
        ],
      }),
    );
    expect(await planState(mcpPlan)).toEqual([]);

    const jobPlanId = await jobPlan(fx, 'job-6633-cycle');
    const viaInternalAppend = await httpRefusal(
      await internalAppend(fx, {
        jobId: 'job-6633-cycle',
        proposals: [{ op: 'modify', workItemId: b.id, patch: cycleOnB }],
      }),
    );
    expect(await planState(jobPlanId)).toEqual([]);

    // Corrections: a harmless modify of B, then a patch that closes the ring; and
    // for the human route, an add X that B supersedes, then X supersedes A:
    // X → A → B → X, through the live A → B.
    const [addId] = await seed(fx, jobPlanId, [
      { op: 'add', proposedFields: { title: 'X — a new card', kind: 'task' } },
    ]);
    const [modifyId] = await seed(fx, jobPlanId, [
      {
        op: 'modify',
        workItemId: b.id,
        patch: { obsolescence: 'outdated', supersedesAdd: [`planItem:${addId}`] },
      },
    ]);
    await close(fx, jobPlanId);
    const before = await planState(jobPlanId);
    const viaMcpCorrect = mcpRefusal(
      await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId: jobPlanId,
        planItemId: modifyId,
        patch: { obsolescence: 'outdated', supersedesAdd: [a.identifier] },
      }),
    );
    const viaInternalCorrect = await httpRefusal(
      await internalCorrect(fx, modifyId!, {
        jobId: 'job-6633-cycle',
        mode: 'correct',
        modifyPatch: cycleOnB,
      }),
    );
    const viaHuman = await httpRefusal(
      await humanPatch(fx, jobPlanId, addId!, { supersedesRefs: [a.id] }),
    );
    expect(await planState(jobPlanId)).toEqual(before);

    for (const r of [
      viaMcpAppend,
      viaInternalAppend,
      viaMcpCorrect,
      viaInternalCorrect,
      viaHuman,
    ]) {
      expect(r.code).toBe('INVALID_PLAN_REF_GRAPH');
      expect(r.message).toContain('SUPERSEDES cycle');
    }
    for (const r of [viaInternalAppend, viaInternalCorrect, viaHuman]) {
      expect(r.reason).toBe('cycle');
    }
    // Nothing drawn: the live link is the only row.
    expect(await supersedesRows(fx)).toEqual([edge(a.id, b.id)]);
    await client.close();
  });
});

describe('a NON-MARK key on a done target is PLAN_TARGET_IMMUTABLE whichever door wrote it', () => {
  it('the appends are refused at the close; the corrections at the correction itself', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const refusals: Refusal[] = [];
    const targets: string[] = [];

    {
      const target = await doneCard(fx, 'Via MCP append');
      targets.push(target.id);
      const planId = await openMcpPlan(client, fx);
      const r = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId,
        proposals: [
          {
            op: 'modify',
            workItemId: target.id,
            patch: { obsolescence: 'outdated', title: 'Renamed' },
          },
        ],
      });
      // The append takes it (the carve-out is judged on the whole plan) …
      expect(r.isError).toBeFalsy();
      // … and the close refuses it before approve can write.
      refusals.push(await refusalOnTheWay(fx, planId));
    }
    {
      const target = await doneCard(fx, 'Via internal append');
      targets.push(target.id);
      const planId = await jobPlan(fx, 'job-6633-immutable-append');
      const res = await internalAppend(fx, {
        jobId: 'job-6633-immutable-append',
        proposals: [
          {
            op: 'modify',
            workItemId: target.id,
            patch: { obsolescence: 'outdated', priority: 'high' },
          },
        ],
      });
      expect(res.status).toBe(200);
      refusals.push(await refusalOnTheWay(fx, planId));
    }
    {
      const target = await doneCard(fx, 'Via update_plan_proposal');
      targets.push(target.id);
      const planId = await jobPlan(fx, 'job-6633-immutable-mcp-correct');
      const [modifyId] = await seed(fx, planId, [
        { op: 'modify', workItemId: target.id, patch: { obsolescence: 'outdated' } },
      ]);
      await close(fx, planId);
      const r = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId,
        planItemId: modifyId,
        patch: { obsolescence: 'outdated', descriptionMd: 'Re-scoped.' },
      });
      // A correction re-runs the persist gate over the replacement patch, so it
      // is refused AT the correction, and the stored patch stays mark-only.
      refusals.push(mcpRefusal(r));
      expect(
        (await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId! } })).patch,
      ).toEqual({
        obsolescence: 'outdated',
      });
    }
    {
      const target = await doneCard(fx, 'Via internal correct');
      targets.push(target.id);
      const planId = await jobPlan(fx, 'job-6633-immutable-correct');
      const [modifyId] = await seed(fx, planId, [
        { op: 'modify', workItemId: target.id, patch: { obsolescence: 'outdated' } },
      ]);
      await close(fx, planId);
      const res = await internalCorrect(fx, modifyId!, {
        jobId: 'job-6633-immutable-correct',
        mode: 'correct',
        modifyPatch: { obsolescence: 'outdated', storyPoints: 3 },
      });
      // 409 — the shape the approve route answers the same refusal with.
      refusals.push(await httpRefusal(res, 409));
      expect(
        (await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId! } })).patch,
      ).toEqual({
        obsolescence: 'outdated',
      });
    }

    expect(refusals.map((r) => r.code)).toEqual(Array(4).fill('PLAN_TARGET_IMMUTABLE'));
    for (const id of targets) {
      const after = await row(id);
      expect(after.obsolescence).toBeNull();
      expect(after.status).toBe('done');
    }
    await client.close();
  });
});

describe('a mark on an UNFINISHED target is refused at every door, and at approve', () => {
  it('MCP append, internal append, update_plan_proposal, internal correct, and a target reopened before approve', async () => {
    const fx = await makeWorkItemFixture();
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'Still in flight' });
    await adminDb.workItem.update({ where: { id: open.id }, data: { status: 'in_progress' } });
    const client = await connectClient(fx.ctx);

    const mcpPlan = await openMcpPlan(client, fx);
    const viaMcpAppend = mcpRefusal(
      await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
        planId: mcpPlan,
        proposals: [{ op: 'modify', workItemId: open.id, patch: { obsolescence: 'outdated' } }],
      }),
    );
    expect(await planState(mcpPlan)).toEqual([]);

    const jobPlanId = await jobPlan(fx, 'job-6633-unfinished');
    const viaInternalAppend = await httpRefusal(
      await internalAppend(fx, {
        jobId: 'job-6633-unfinished',
        proposals: [{ op: 'modify', workItemId: open.id, patch: { obsolescence: 'deprecated' } }],
      }),
    );
    expect(await planState(jobPlanId)).toEqual([]);

    // A correction of a harmless modify that would SET a mark.
    const [modifyId] = await seed(fx, jobPlanId, [
      { op: 'modify', workItemId: open.id, patch: { priority: 'low' } },
    ]);
    await close(fx, jobPlanId);
    const before = await planState(jobPlanId);
    const viaMcpCorrect = mcpRefusal(
      await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
        planId: jobPlanId,
        planItemId: modifyId,
        patch: { obsolescence: 'outdated' },
      }),
    );
    const viaInternalCorrect = await httpRefusal(
      await internalCorrect(fx, modifyId!, {
        jobId: 'job-6633-unfinished',
        mode: 'correct',
        modifyPatch: { obsolescence: 'deprecated' },
      }),
    );
    expect(await planState(jobPlanId)).toEqual(before);

    // At approve: finished at the append, reopened before the button.
    const reopened = await doneCard(fx, 'Reopened later');
    const approvePlan = await servicePlan(fx);
    await seed(fx, approvePlan, [
      { op: 'modify', workItemId: reopened.id, patch: { obsolescence: 'outdated' } },
    ]);
    await adminDb.workItem.update({ where: { id: reopened.id }, data: { status: 'todo' } });
    const atApprove = await refusalOnTheWay(fx, approvePlan);

    for (const r of [
      viaMcpAppend,
      viaInternalAppend,
      viaMcpCorrect,
      viaInternalCorrect,
      atApprove,
    ]) {
      expect(r.code).toBe('INVALID_PROPOSAL');
      expect(r.message).toContain(FINISHED_ONLY);
      expect(r.message).toContain("op: 'remove'");
    }
    expect((await row(open.id)).obsolescence).toBeNull();
    expect((await row(reopened.id)).obsolescence).toBeNull();
    await client.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The contract guard — four key lists, one set
// ════════════════════════════════════════════════════════════════════════════

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

/** The object branch of a (possibly nullable) JSON-Schema node. */
function objectOf(node: JsonSchema | undefined): JsonSchema {
  if (!node) throw new Error('schema node missing');
  if (node.properties) return node;
  const branch = [...(node.anyOf ?? []), ...(node.oneOf ?? [])].find((b) => b.properties);
  if (!branch) throw new Error('no object branch');
  return branch;
}

describe('the contract guard — PLAN_ITEM_PATCH_KEYS, PLAN_ITEM_MARK_PATCH_KEYS, PATCH_KEY_RAIL_ROW and the MCP patchSchema', () => {
  it('name the same keys, and every mark key moves a MARK rail row', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const schemaOf = (name: string) =>
      tools.find((t) => t.name === name)!.inputSchema as unknown as JsonSchema;

    const appendPatch = objectOf(
      objectOf(schemaOf(ADD_PLAN_ITEMS_TOOL_NAME).properties!['proposals']!.items).properties![
        'patch'
      ],
    );
    const correctPatch = objectOf(schemaOf(UPDATE_PLAN_PROPOSAL_TOOL_NAME).properties!['patch']);

    const declared = [...PLAN_ITEM_PATCH_KEYS].sort();
    expect(Object.keys(PATCH_KEY_RAIL_ROW).sort()).toEqual(declared);
    expect(Object.keys(appendPatch.properties!).sort()).toEqual(declared);
    expect(Object.keys(correctPatch.properties!).sort()).toEqual(declared);

    // The mark keys are a subset of the patch, and their rail rows are EXACTLY the
    // review's mark group — a seventh mark key needs a row there, and a row there
    // needs a mark key.
    for (const key of PLAN_ITEM_MARK_PATCH_KEYS) expect(declared).toContain(key);
    const markRowsOfKeys = new Set(PLAN_ITEM_MARK_PATCH_KEYS.map((k) => PATCH_KEY_RAIL_ROW[k]));
    expect([...markRowsOfKeys].sort()).toEqual([...PLAN_ITEM_MARK_CHANGE_FIELDS].sort());
    // …and no NON-mark key lands on a mark row (that key would be admitted to the
    // review's mark group while the carve-out still refuses it on a done card).
    const nonMark = PLAN_ITEM_PATCH_KEYS.filter(
      (k) => !(PLAN_ITEM_MARK_PATCH_KEYS as readonly string[]).includes(k),
    );
    for (const key of nonMark) {
      expect(PLAN_ITEM_MARK_CHANGE_FIELDS as readonly (string | null)[]).not.toContain(
        PATCH_KEY_RAIL_ROW[key],
      );
    }
    await client.close();
  });
});
