import { beforeEach, describe, expect, it, vi } from 'vitest';

// motir-ai is the only thing stubbed. Every route, service, Plan row and
// response below is real, against real Postgres — the stub replaces the network
// hop and nothing else, so a synchronous or mis-shaped implementation still
// fails here.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
}));

import { POST as EXPAND } from '@/app/api/v1/work-items/[key]/expansions/route';
import { GET as GET_PLAN } from '@/app/api/v1/plans/[planId]/route';
import { GET as GET_STATUS } from '@/app/api/v1/plans/[planId]/status/route';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiOutOfCreditsError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import {
  planJobHandleSchema,
  planOutcomeSchema,
  planSchema,
  type V1Plan,
  type V1PlanJobHandle,
  type V1PlanOutcome,
} from '@/lib/api/v1/workLoop/schema';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { runGetPlan } from '@/lib/mcp/tools/getPlan';
import { runGetPlanStatus } from '@/lib/mcp/tools/expandItem';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Expansion + the two PLAN reads (Story 11.7 · Subtask 11.7.5 — MOTIR-2239).
//
// Four properties carry the card:
//
//   • The submit RETURNS BEFORE the planner. Asserted with the planner stubbed
//     to be SLOW, so a synchronous implementation fails rather than merely
//     taking longer.
//   • NOTHING here creates a work item. The work-item table is counted before
//     and after a whole submit-and-read cycle.
//   • The status read distinguishes generating-and-ALIVE from generating-but-
//     DEAD. A failed job leaves its plan generating forever; a client that
//     cannot tell polls indefinitely.
//   • A client cannot mistake a proposal for a work item FROM THE PAYLOAD —
//     `proposalCount`, and an `add` whose `workItemKey` is null.

const BASE = 'http://localhost:3000/api/v1';

function expand(caller: V1ProjectCaller, key: string): Promise<Response> {
  return EXPAND(
    new Request(`${BASE}/work-items/${key}/expansions`, {
      method: 'POST',
      headers: caller.headers,
    }),
    {
      params: Promise.resolve({ key }),
    },
  );
}

function readPlan(caller: V1ProjectCaller, planId: string): Promise<Response> {
  return GET_PLAN(new Request(`${BASE}/plans/${planId}`, { headers: caller.headers }), {
    params: Promise.resolve({ planId }),
  });
}

function readStatus(caller: V1ProjectCaller, planId: string): Promise<Response> {
  return GET_STATUS(new Request(`${BASE}/plans/${planId}/status`, { headers: caller.headers }), {
    params: Promise.resolve({ planId }),
  });
}

async function makeStory(caller: V1ProjectCaller, title = 'a container') {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title },
    caller.ctx,
  );
}

/** Every work item in the caller's project, so "nothing was created" is countable. */
async function workItemCount(caller: V1ProjectCaller): Promise<number> {
  const { items } = await workItemsService.listProjectWorkItemsPage(
    caller.fixture.projectId,
    { limit: 100 },
    caller.ctx,
  );
  return items.length;
}

function acceptJob(jobId = 'job_1'): void {
  vi.mocked(submitJob).mockResolvedValue({ jobId } as Awaited<ReturnType<typeof submitJob>>);
}

describe('POST /api/v1/work-items/{key}/expansions', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('answers 202 with a handle carrying no result', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const story = await makeStory(caller);
    acceptJob();

    const res = await expand(caller, story.identifier);

    expect(res.status).toBe(202);
    const body = (await res.json()) as V1PlanJobHandle;
    expect(() => planJobHandleSchema.parse(body)).not.toThrow();
    expect(body.jobId).toBe('job_1');
    expect(body.statusUrl).toBe(`/api/v1/plans/${body.planId}/status`);
    // The whole shape: nothing a result could arrive in.
    expect(Object.keys(body).sort()).toEqual(['jobId', 'planId', 'statusUrl']);
  });

  it('returns WITHOUT waiting for the planner', async () => {
    // The planner is stubbed SLOW. A synchronous implementation would block on
    // it; this one returns as soon as the job is accepted, so the elapsed time
    // stays far below the planner's own.
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const story = await makeStory(caller);
    const PLANNER_MS = 2_000;
    vi.mocked(submitJob).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // What a caller would be waiting on if the submit were synchronous: the
      // planner's own run, which nothing here awaits.
      void new Promise((resolve) => setTimeout(resolve, PLANNER_MS));
      return { jobId: 'job_slow' } as Awaited<ReturnType<typeof submitJob>>;
    });

    const started = performance.now();
    const res = await expand(caller, story.identifier);
    const elapsed = performance.now() - started;

    expect(res.status).toBe(202);
    expect(elapsed).toBeLessThan(PLANNER_MS);
  });

  it('creates NO work item across a whole submit-and-read cycle', async () => {
    // The gate this whole resource is built around: approval in Motir is the
    // only path from a proposal to a `work_item` row.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const story = await makeStory(caller);
    acceptJob();
    const before = await workItemCount(caller);

    const handle = (await (await expand(caller, story.identifier)).json()) as V1PlanJobHandle;
    await plansService.addProposals(
      handle.planId,
      [{ op: 'add', proposedFields: { title: 'a proposed child', kind: 'subtask' } }],
      caller.ctx,
    );
    await readStatus(caller, handle.planId);
    await readPlan(caller, handle.planId);

    expect(await workItemCount(caller)).toBe(before);
  });

  it('refuses a LEAF — 422, the request the caller can fix', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const parent = await makeStory(caller, 'a parent');
    const leaf = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'a leaf',
        parentId: parent.id,
      },
      caller.ctx,
    );
    acceptJob();

    const res = await expand(caller, leaf.identifier);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_TARGET');
    expect(DOMAIN_ERROR_STATUS['INVALID_TARGET']).toBe(422);
    // Nothing was submitted: the guard runs before the job.
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });

  it('answers 402 when the owner’s AI credits are exhausted', async () => {
    // Not 422 (the body is fine) and not 429 (no window refills this) — the
    // right instruction is "top up".
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const story = await makeStory(caller);
    vi.mocked(submitJob).mockRejectedValue(new MotirAiOutOfCreditsError('balance 0'));

    const res = await expand(caller, story.identifier);

    expect(res.status).toBe(402);
    expect(((await res.json()) as { code: string }).code).toBe('MOTIR_AI_OUT_OF_CREDITS');
  });

  it('answers 503 when motir-ai cannot be reached, leaving NO orphan plan', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const story = await makeStory(caller);
    vi.mocked(submitJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const res = await expand(caller, story.identifier);

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('MOTIR_AI_UNAVAILABLE');
    // The service submits BEFORE opening the plan precisely so a failed submit
    // writes nothing; asserted here so the endpoint cannot regress it.
    const plans = await plansService.listPlans(caller.fixture.projectId, caller.ctx);
    expect(plans.plans).toEqual([]);
  });

  it('refuses a read-only token — 403', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const story = await makeStory(caller);

    expect((await expand(caller, story.identifier)).status).toBe(403);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });

  it('answers 404 for a key in another workspace', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const theirs = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const hidden = await makeStory(theirs, 'not yours');
    acceptJob();

    // 404, never 403 and never 422: an item this token cannot see and one that
    // never existed are the same answer (§4's existence-oracle rule). The two
    // fixtures share a project KEY, so the key resolves locally and it is the
    // ITEM read that must answer — which is why the route does one.
    expect((await expand(mine, hidden.identifier)).status).toBe(404);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/plans/{planId}/status', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  async function submittedPlan(caller: V1ProjectCaller): Promise<string> {
    const story = await makeStory(caller);
    acceptJob('job_status');
    const handle = (await (await expand(caller, story.identifier)).json()) as V1PlanJobHandle;
    return handle.planId;
  }

  it('reports GENERATING and the job ALIVE', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await submittedPlan(caller);
    vi.mocked(getJob).mockResolvedValue({ status: 'running' } as Awaited<
      ReturnType<typeof getJob>
    >);

    const res = await readStatus(caller, planId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1PlanOutcome;
    expect(() => planOutcomeSchema.parse(body)).not.toThrow();
    expect(body.status).toBe('generating');
    expect(body.job).toEqual({ status: 'running', reachable: true, failure: null });
    // Renamed from the DTO's `itemCount`: these are proposals, not work items.
    expect(body.proposalCount).toBe(0);
  });

  it('reports GENERATING and the job DEAD — the distinction this endpoint exists for', async () => {
    // A failed job leaves its plan at `generating` forever, so `status` alone
    // would have a client polling indefinitely.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await submittedPlan(caller);
    vi.mocked(getJob).mockResolvedValue({
      status: 'failed',
      error: { code: 'PLANNER_CRASHED', message: 'the model returned nothing' },
    } as Awaited<ReturnType<typeof getJob>>);

    const body = (await (await readStatus(caller, planId)).json()) as V1PlanOutcome;

    expect(body.status).toBe('generating');
    expect(body.job?.reachable).toBe(true);
    expect(body.job?.failure).toEqual({
      code: 'PLANNER_CRASHED',
      message: 'the model returned nothing',
    });
  });

  it('degrades to `reachable: false` when motir-ai cannot be asked', async () => {
    // The PLAN read succeeded, so the answer is served with the job block
    // degraded rather than failed — and `reachable: false` is NOT "the job died".
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await submittedPlan(caller);
    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const res = await readStatus(caller, planId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1PlanOutcome;
    expect(body.job?.reachable).toBe(false);
    expect(body.job?.status).toBeNull();
  });

  it('matches the MCP tool’s payload for the fields both publish', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await submittedPlan(caller);
    vi.mocked(getJob).mockResolvedValue({ status: 'running' } as Awaited<
      ReturnType<typeof getJob>
    >);

    const body = (await (await readStatus(caller, planId)).json()) as V1PlanOutcome;
    const tool = await runGetPlanStatus({ planId }, caller.ctx);
    const payload = tool.structuredContent as Record<string, unknown>;

    expect(body.planId).toBe(payload['planId']);
    expect(body.status).toBe(payload['status']);
    expect(body.origin).toBe(payload['origin']);
    expect(body.jobId).toBe(payload['jobId']);
    expect(body.job).toEqual(payload['job']);
    // The one renamed field, and the one dropped one.
    expect(body.proposalCount).toBe(payload['itemCount']);
    expect(body).not.toHaveProperty('projectId');
  });

  it('404s an unknown plan, and one in another workspace', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const theirs = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const hidden = await submittedPlan(theirs);

    expect((await readStatus(mine, 'plan_does_not_exist')).status).toBe(404);
    expect((await readStatus(mine, hidden)).status).toBe(404);
    expect(DOMAIN_ERROR_STATUS['PLAN_NOT_FOUND']).toBe(404);
  });

  it('refuses a token with no `read` scope — 403', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const planId = await submittedPlan(caller);

    expect((await readStatus(caller, planId)).status).toBe(403);
  });
});

describe('GET /api/v1/plans/{planId}', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  async function planWithProposals(caller: V1ProjectCaller): Promise<{
    planId: string;
    targetKey: string;
  }> {
    const story = await makeStory(caller);
    const existing = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'an existing item' },
      caller.ctx,
    );
    acceptJob('job_plan');
    const handle = (await (await expand(caller, story.identifier)).json()) as V1PlanJobHandle;
    await plansService.addProposals(
      handle.planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'a proposed child', kind: 'subtask', storyPoints: 3 },
        },
        { op: 'modify', workItemId: existing.id, patch: { title: 'renamed' } },
      ],
      caller.ctx,
    );
    return { planId: handle.planId, targetKey: existing.identifier };
  }

  it('returns the proposals, and says they are proposals', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const { planId, targetKey } = await planWithProposals(caller);

    const res = await readPlan(caller, planId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Plan;
    expect(() => planSchema.parse(body)).not.toThrow();
    expect(body.proposalCount).toBe(2);
    // The count is named for what it counts, and the payload has no `itemCount`
    // a client could read as "work items exist".
    expect(body).not.toHaveProperty('itemCount');

    const add = body.proposals.find((p) => p.op === 'add');
    // ⚠️ THE contract: an `add` targets nothing, and stays that way until a human
    // approves the plan in Motir.
    expect(add?.workItemKey).toBeNull();
    expect(add?.proposedFields?.title).toBe('a proposed child');
    expect(add?.proposedFields?.storyPoints).toBe(3);

    const modify = body.proposals.find((p) => p.op === 'modify');
    // A `modify` names an EXISTING item — by its key, never the internal cuid.
    expect(modify?.workItemKey).toBe(targetKey);
    expect(modify?.proposedFields).toBeNull();
  });

  it('never puts a work-item cuid on the wire', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const story = await makeStory(caller);
    const existing = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'target' },
      caller.ctx,
    );
    acceptJob();
    const handle = (await (await expand(caller, story.identifier)).json()) as V1PlanJobHandle;
    await plansService.addProposals(
      handle.planId,
      [{ op: 'remove', workItemId: existing.id }],
      caller.ctx,
    );

    const raw = await (await readPlan(caller, handle.planId)).text();

    expect(raw).not.toContain(existing.id);
    expect(raw).toContain(existing.identifier);
  });

  it('resolves the whole page’s targets in ONE batched read, not one per proposal', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const story = await makeStory(caller);
    const targets = [];
    for (let i = 0; i < 8; i += 1) {
      targets.push(
        await workItemsService.createWorkItem(
          { projectId: caller.fixture.projectId, kind: 'task', title: `target ${i}` },
          caller.ctx,
        ),
      );
    }
    acceptJob();
    const handle = (await (await expand(caller, story.identifier)).json()) as V1PlanJobHandle;
    await plansService.addProposals(
      handle.planId,
      targets.map((t) => ({ op: 'remove' as const, workItemId: t.id })),
      caller.ctx,
    );
    const spy = vi.spyOn(workItemsService, 'resolveReferenceSummaries');

    const body = (await (await readPlan(caller, handle.planId)).json()) as V1Plan;

    expect(body.proposals).toHaveLength(8);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].ids).toHaveLength(8);
  });

  it('leaves an UNRESOLVABLE target null rather than leaking its id', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const story = await makeStory(caller);
    const doomed = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'about to vanish' },
      caller.ctx,
    );
    acceptJob();
    const handle = (await (await expand(caller, story.identifier)).json()) as V1PlanJobHandle;
    await plansService.addProposals(
      handle.planId,
      [{ op: 'remove', workItemId: doomed.id }],
      caller.ctx,
    );
    await workItemsService.deleteWorkItem(doomed.id, caller.ctx);

    const body = (await (await readPlan(caller, handle.planId)).json()) as V1Plan;

    expect(body.proposals[0]?.workItemKey).toBeNull();
    expect(JSON.stringify(body)).not.toContain(doomed.id);
  });

  it('matches the MCP tool’s payload for the fields both publish', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const { planId } = await planWithProposals(caller);

    const body = (await (await readPlan(caller, planId)).json()) as V1Plan;
    const tool = await runGetPlan({ planId }, caller.ctx);
    const payload = tool.structuredContent as Record<string, unknown>;

    expect(body.id).toBe(payload['id']);
    expect(body.status).toBe(payload['status']);
    expect(body.origin).toBe(payload['origin']);
    expect(body.sourceJobId).toBe(payload['sourceJobId']);
    expect(body.proposalCount).toBe(payload['itemCount']);
    const toolItems = payload['items'] as { op: string; parentRef: string | null }[];
    expect(body.proposals.map((p) => p.op)).toEqual(toolItems.map((i) => i.op));
  });

  it('404s an unknown plan and one in another workspace; 403s without `read`', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const theirs = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const { planId: hidden } = await planWithProposals(theirs);
    const writeOnly = await createV1ProjectCaller({ scopes: ['work_items:write'] });

    expect((await readPlan(mine, 'plan_nope')).status).toBe(404);
    expect((await readPlan(mine, hidden)).status).toBe(404);
    expect((await readPlan(writeOnly, hidden)).status).toBe(403);
  });
});

describe('the plan operations’ contract', () => {
  it('carries the scope each MCP counterpart holds, read off the shipped map', () => {
    const byId = new Map(WORK_LOOP_OPERATIONS.map((op) => [op.operationId, op]));
    expect(byId.get('submitWorkItemExpansion')?.scope).toBe(TOOL_SCOPES.expand_item);
    expect(byId.get('getPlanStatus')?.scope).toBe(TOOL_SCOPES.get_plan_status);
    expect(byId.get('getPlan')?.scope).toBe(TOOL_SCOPES.get_plan);
    // …and the submit is a WRITE scope because it spends credits, which the map
    // reasons out at its own entry.
    expect(TOOL_SCOPES.expand_item).toBe('work_items:write');
  });

  it('tells an integrator, in the endpoint’s own description, that a submit spends credits', () => {
    const submit = WORK_LOOP_OPERATIONS.find((op) => op.operationId === 'submitWorkItemExpansion');
    expect(submit?.description).toMatch(/credits/i);
    // …and answers 202, never 200: "accepted" must be distinguishable from
    // "done" at the layer a generic client inspects.
    expect(submit?.response.status).toBe(202);
  });
});
