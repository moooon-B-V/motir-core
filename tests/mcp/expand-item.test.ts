import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan-edit suites,
// e.g. tests/integration/ai/autoPlanCadence.test.ts). Everything below it is
// real: a real Postgres, the real MCP server + transport, the real
// `aiPlanEditsService.submitExpand` → `plansService.createPlan` transaction and
// the real plan reads. So what these tests assert about the Plan rows and the
// work-item tree is what production actually writes.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { getJob, streamJob, submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiOutOfCreditsError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { toolScope } from '@/lib/mcp/scopes';
import { EXPAND_ITEM_TOOL_NAME, GET_PLAN_STATUS_TOOL_NAME } from '@/lib/mcp/tools/expandItem';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// `expand_item` + `get_plan_status` (Story 7.9 · MOTIR-1825) — the MCP surface
// for AI plan expansion, and the outcome read a NON-INTERACTIVE client needs.
//
// The three contracts these lock, in the order a caller meets them:
//
//   1. SUBMIT AND RETURN — the tool hands back `{ jobId, planId }` the instant
//      motir-ai accepts the job; it never streams and never polls. Asserted
//      NEGATIVELY too (`streamJob` / `getJob` untouched on the submit path),
//      because "it happened not to block this time" is not the contract.
//   2. THE PLAN APPROVAL GATE — an expansion PROPOSES. No work item appears from
//      firing it, from proposals landing, or from the plan reaching `planned`.
//      Only `approvePlan` materializes, and it is not on this surface at all.
//   3. THE FAILED JOB IS VISIBLE — a job that dies leaves its plan at
//      `generating` forever, so the plan status alone would strand a poller.
//      `get_plan_status` consults the job to tell "running" from "died", and
//      degrades (rather than throws) when motir-ai itself can't be asked.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// tools.test.ts pattern). The bearer/auth plumbing and the per-token scope gate
// are the story-roundtrip suite's job — which also loops these two tools through
// its permission-parity and scope matrices by construction.

const struct = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;
const text = (r: CallToolResult) => JSON.stringify(r.content);

/** Connect an in-memory client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'expand-item', version: '0.0.0' });
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

/** A childless story — the canonical expansion target. */
async function makeStory(fx: WorkItemFixture, title = 'Expandable story') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'story', title }, fx.ctx);
}

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_expand_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('expand_item — registration + scope', () => {
  it('is registered under a stable name and gated by work_items:write; the outcome read is a read', () => {
    expect(MCP_TOOL_NAMES).toContain(EXPAND_ITEM_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(GET_PLAN_STATUS_TOOL_NAME);
    // Submitting spends the owner's AI credits and opens a Plan row, so a
    // read-only token must not be able to fire one.
    expect(toolScope(EXPAND_ITEM_TOOL_NAME)).toBe('work_items:write');
    expect(toolScope(GET_PLAN_STATUS_TOOL_NAME)).toBe('read');
  });

  it('advertises the proposal-not-a-tree-write contract in its own description', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const expand = tools.find((t) => t.name === EXPAND_ITEM_TOOL_NAME);
    const status = tools.find((t) => t.name === GET_PLAN_STATUS_TOOL_NAME);
    // The description is the ONLY thing standing between an agent and the
    // inference that firing this grew the tree — assert it says so.
    expect(expand?.description).toMatch(/does NOT create work items/i);
    expect(expand?.description).toMatch(/approv/i);
    expect(status?.description).toMatch(/NOT a count of created work items/i);
    await client.close();
  });
});

describe('expand_item — submit and return', () => {
  it('returns { jobId, planId } for a childless story WITHOUT waiting on motir-ai', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const client = await connectClient(fx.ctx);

    const res = await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier });
    expect(res.isError).toBeFalsy();
    const out = struct(res) as { jobId: string; planId: string };
    expect(out.jobId).toBe('job_expand_1');
    expect(out.planId).toBeTruthy();

    // The submit went out as the shipped expand_item job kind, with the item as
    // its root — the tool is a transport over the SAME service the cookie route
    // calls, not a second submit path.
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('expand_item');
    expect((context as { rootItemKey?: string }).rootItemKey).toBe(story.identifier);

    // Return-immediately, asserted negatively: nothing streamed, nothing polled.
    expect(vi.mocked(streamJob)).not.toHaveBeenCalled();
    expect(vi.mocked(getJob)).not.toHaveBeenCalled();

    // The proposal sink exists and is open (MOTIR-1743's opened Plan).
    const plan = await plansService.getPlan(out.planId, fx.ctx);
    expect(plan.status).toBe('generating');
    expect(plan.sourceJobId).toBe('job_expand_1');
    expect(plan.origin).toBe('user');
    await client.close();
  });

  it('rejects a LEAF with the typed invalid-target error, and submits nothing', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const leaf = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'A leaf', parentId: story.id },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const res = await call(client, EXPAND_ITEM_TOOL_NAME, { key: leaf.identifier });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('INVALID_TARGET');
    expect(text(res)).toContain('subtask');
    // The kind check runs BEFORE the job — a rejected target costs no credits.
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    expect(await db.plan.count()).toBe(0);
    await client.close();
  });

  it('surfaces an out-of-credits refusal as its own typed code, and opens no orphan plan', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    vi.mocked(submitJob).mockRejectedValue(new MotirAiOutOfCreditsError('balance 0'));
    const client = await connectClient(fx.ctx);

    const res = await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier });
    expect(res.isError).toBe(true);
    // The distinct, non-retryable code — an agent must not read this as a
    // generic outage and retry forever.
    expect(text(res)).toContain('MOTIR_AI_OUT_OF_CREDITS');
    // The plan is opened only AFTER a successful submit, so a refused job leaves
    // nothing behind.
    expect(await db.plan.count()).toBe(0);
    await client.close();
  });

  it('a work item in another project reads as not-found, never a leak (404-not-403)', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const story = await makeStory(a);
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connectClient(outsider.ctx);

    const res = await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('NOT_FOUND');
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('expand_item — the Plan approval gate (no work item is created)', () => {
  it('a submitted, PROPOSED and PLANNED expansion leaves the target childless', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const client = await connectClient(fx.ctx);

    const before = await db.workItem.count({ where: { projectId: fx.projectId } });
    const res = await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier });
    const planId = (struct(res) as { planId: string }).planId;

    // (1) Right after the submit.
    expect(await db.workItem.count({ where: { parentId: story.id } })).toBe(0);

    // (2) After the planner's proposals actually land — the state a caller
    // polling to `planned` would see. These are PlanItems; the `add`'s
    // workItemId stays NULL until approve.
    await plansService.addProposals(
      planId,
      [
        { op: 'add', proposedFields: { title: 'Proposed child A', kind: 'subtask' } },
        { op: 'add', proposedFields: { title: 'Proposed child B', kind: 'subtask' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    const outcome = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId });
    expect((struct(outcome) as { status: string }).status).toBe('planned');
    expect((struct(outcome) as { itemCount: number }).itemCount).toBe(2);

    // The tree is byte-for-byte unchanged: no children, no new rows anywhere,
    // and every proposal still un-materialized.
    expect(await db.workItem.count({ where: { parentId: story.id } })).toBe(0);
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    expect(await db.planItem.count({ where: { planId, workItemId: null } })).toBe(2);
    await client.close();
  });
});

describe('get_plan_status — the outcome read', () => {
  it('addresses the same plan by planId OR by jobId, and reports it still generating', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const client = await connectClient(fx.ctx);
    const submitted = struct(
      await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier }),
    ) as { jobId: string; planId: string };

    vi.mocked(getJob).mockResolvedValue({
      jobId: submitted.jobId,
      status: 'running',
      result: null,
      error: null,
    });

    const byPlan = struct(
      await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId: submitted.planId }),
    );
    const byJob = struct(await call(client, GET_PLAN_STATUS_TOOL_NAME, { jobId: submitted.jobId }));

    // Both ids come out of the SAME submit result, so both must land on it.
    expect(byPlan).toEqual(byJob);
    expect(byPlan['status']).toBe('generating');
    expect(byPlan['itemCount']).toBe(0);
    expect(byPlan['jobId']).toBe(submitted.jobId);
    expect(byPlan['job']).toEqual({ status: 'running', reachable: true, failure: null });
    await client.close();
  });

  it('a FAILED job is reported — the plan alone would say "generating" forever', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const client = await connectClient(fx.ctx);
    const { planId, jobId } = struct(
      await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier }),
    ) as { jobId: string; planId: string };

    vi.mocked(getJob).mockResolvedValue({
      jobId,
      status: 'failed',
      result: null,
      error: new MotirAiUnavailableError('planner crashed'),
    });

    const res = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId });
    expect(res.isError).toBeFalsy();
    const out = struct(res);
    // The PLAN status is unchanged and honest — nothing writes a terminal plan
    // state on failure. The job block is what makes the death visible.
    expect(out['status']).toBe('generating');
    expect(out['job']).toEqual({
      status: 'failed',
      reachable: true,
      failure: {
        code: 'MOTIR_AI_UNAVAILABLE',
        message: expect.stringContaining('planner crashed'),
      },
    });
    expect(text(res)).toContain('FAILED');
    await client.close();
  });

  it('an unreachable motir-ai degrades to reachable:false — the plan read still answers', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const client = await connectClient(fx.ctx);
    const { planId } = struct(
      await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier }),
    ) as { planId: string };

    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const res = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId });
    // Not an error: the plan read succeeded, only the job probe didn't. The flag
    // is what stops a caller reading this as "your expansion died".
    expect(res.isError).toBeFalsy();
    const job = struct(res)['job'] as { status: null; reachable: boolean };
    expect(job.reachable).toBe(false);
    expect(job.status).toBeNull();
    await client.close();
  });

  it('a settled plan is answered from the plan alone — motir-ai is never asked', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const client = await connectClient(fx.ctx);
    const { planId } = struct(
      await call(client, EXPAND_ITEM_TOOL_NAME, { key: story.identifier }),
    ) as { planId: string };
    await plansService.markPlanned(planId, fx.ctx);
    vi.mocked(getJob).mockClear();

    const res = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId });
    expect((struct(res) as { status: string }).status).toBe('planned');
    // A planned plan's job already delivered — probing it would be a pointless
    // round-trip on every poll.
    expect(struct(res)['job']).toBeNull();
    expect(vi.mocked(getJob)).not.toHaveBeenCalled();
    await client.close();
  });

  it('an APPROVED plan says its proposals were materialized; a job-less plan reports jobId null', async () => {
    const fx = await makeWorkItemFixture();
    // A plan with no `sourceJobId` — the shape a producer that never bound a job
    // leaves behind. The read must still answer rather than assume a job exists.
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: null, summary: null, sourceJobId: null },
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const client = await connectClient(fx.ctx);
    const res = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId: plan.id });
    expect(res.isError).toBeFalsy();
    const out = struct(res);
    expect(out['status']).toBe('approved');
    expect(out['jobId']).toBeNull();
    expect(out['job']).toBeNull();
    expect(out['decidedAt']).toBeTruthy();
    // Approved is the ONE state where the summary may speak of work items —
    // everywhere else it must insist these are proposals.
    expect(text(res)).toContain('materialized');
    expect(vi.mocked(getJob)).not.toHaveBeenCalled();
    await client.close();
  });

  it('requires exactly one of planId / jobId', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);

    const neither = await call(client, GET_PLAN_STATUS_TOOL_NAME, {});
    expect(neither.isError).toBe(true);
    expect(text(neither)).toContain('BAD_REQUEST');

    const both = await call(client, GET_PLAN_STATUS_TOOL_NAME, { planId: 'p', jobId: 'j' });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain('BAD_REQUEST');
    await client.close();
  });

  it('an unknown plan / job, and another tenant’s plan, all read as not-found', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const plan = await plansService.createPlan(
      a.projectId,
      { title: null, summary: null, sourceJobId: 'job_acme' },
      a.ctx,
    );
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });

    const own = await connectClient(a.ctx);
    const missingPlan = await call(own, GET_PLAN_STATUS_TOOL_NAME, { planId: 'plan_nope' });
    expect(missingPlan.isError).toBe(true);
    expect(text(missingPlan)).toContain('PLAN_NOT_FOUND');
    const missingJob = await call(own, GET_PLAN_STATUS_TOOL_NAME, { jobId: 'job_nope' });
    expect(missingJob.isError).toBe(true);
    expect(text(missingJob)).toContain('NO_PLAN_FOR_JOB');
    await own.close();

    // 404-not-403: another workspace's plan is indistinguishable from a missing
    // one, by id AND by job id — no existence leak either way.
    const rival = await connectClient(outsider.ctx);
    const byId = await call(rival, GET_PLAN_STATUS_TOOL_NAME, { planId: plan.id });
    expect(byId.isError).toBe(true);
    expect(text(byId)).toContain('PLAN_NOT_FOUND');
    const byJob = await call(rival, GET_PLAN_STATUS_TOOL_NAME, { jobId: 'job_acme' });
    expect(byJob.isError).toBe(true);
    expect(text(byJob)).toContain('NO_PLAN_FOR_JOB');
    await rival.close();
  });
});
