import { beforeEach, describe, expect, it, vi } from 'vitest';

// motir-ai is the only thing stubbed — the thread, its turns and every response
// are real, against real Postgres.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
}));

import { POST as OPEN } from '@/app/api/v1/projects/[projectKey]/plan-session/route';
import { POST as APPEND } from '@/app/api/v1/projects/[projectKey]/plan-session/turns/route';
import { POST as SUBMIT } from '@/app/api/v1/projects/[projectKey]/plan-session/submissions/route';
import { submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import {
  planJobHandleSchema,
  planSessionSchema,
  type V1PlanJobHandle,
  type V1PlanSession,
} from '@/lib/api/v1/workLoop/schema';
import { MAX_SCOPE_TARGETS, PROJECT_SCOPE, buildScope } from '@/lib/planChange/scope';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { runOpenPlanSession } from '@/lib/mcp/tools/planSession';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The planning CONVERSATION over /api/v1 (Story 11.7 · Subtask 11.7.6 —
// MOTIR-2240) against real Postgres.
//
// The composite address is this card's real design problem, and two properties
// of it are what these tests are for:
//
//   • SAME ANCHOR SET ⇒ SAME THREAD, across BOTH surfaces. If the API could
//     open a second row for a set the web panel already has, the "you cannot
//     fork a conversation about these items" guarantee is gone and the two are
//     talking past each other.
//   • Anchor identity is order- and duplicate-INSENSITIVE, asserted against
//     `buildScope` rather than assumed either way — a client that sorts its keys
//     and one that does not must land on the same row.
//
// Plus the contract every turn depends on: APPENDING IS NOT SUBMITTING.

const BASE = 'http://localhost:3000/api/v1';

function post(
  caller: V1ProjectCaller,
  suffix: string,
  body: unknown,
  projectKey?: string,
): Request {
  const key = projectKey ?? caller.projectKey;
  return new Request(`${BASE}/projects/${key}/plan-session${suffix}`, {
    method: 'POST',
    headers: { ...caller.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function args(caller: V1ProjectCaller, projectKey?: string) {
  return { params: Promise.resolve({ projectKey: projectKey ?? caller.projectKey }) };
}

function open(caller: V1ProjectCaller, body: unknown = {}, projectKey?: string): Promise<Response> {
  return OPEN(post(caller, '', body, projectKey), args(caller, projectKey));
}

function append(caller: V1ProjectCaller, body: unknown): Promise<Response> {
  return APPEND(post(caller, '/turns', body), args(caller));
}

function submit(caller: V1ProjectCaller, body: unknown = {}): Promise<Response> {
  return SUBMIT(post(caller, '/submissions', body), args(caller));
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function makeItem(caller: V1ProjectCaller, title: string) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title },
    caller.ctx,
  );
}

function acceptJob(jobId = 'job_session'): void {
  vi.mocked(submitJob).mockResolvedValue({ jobId } as Awaited<ReturnType<typeof submitJob>>);
}

describe('POST /api/v1/projects/{projectKey}/plan-session', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('opens the project-wide thread and returns it empty', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await open(caller);

    expect(res.status).toBe(200);
    const body = await json<V1PlanSession>(res);
    expect(() => planSessionSchema.parse(body)).not.toThrow();
    expect(body.targetKeys).toEqual([]);
    expect(body.turnCount).toBe(0);
    expect(body.turns).toEqual([]);
    expect(body.lastSubmittedAt).toBeNull();
  });

  it('RESUMES the same thread on a second open, rather than forking one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });

    const first = await json<V1PlanSession>(await open(caller));
    await append(caller, { body: 'a first thought' });
    const second = await json<V1PlanSession>(await open(caller));

    expect(second.id).toBe(first.id);
    expect(second.turnCount).toBe(1);
    expect(second.turns[0]?.body).toBe('a first thought');
  });

  it('resumes the SAME ROW the web panel resolves for that scope', async () => {
    // The guarantee, asserted across BOTH surfaces: the API and the panel must
    // land on one thread or they are talking past each other.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const anchor = await makeItem(caller, 'the anchor');

    const viaApi = await json<V1PlanSession>(
      await open(caller, { targetKeys: [anchor.identifier] }),
    );

    const project = await projectsService.getByKey(caller.projectKey, caller.ctx);
    const viaService = await planChangeSessionsService.getOrCreateForScope(
      {
        userId: caller.ctx.userId,
        workspaceId: caller.ctx.workspaceId,
        projectId: project.id,
        project,
      },
      buildScope([anchor.identifier]),
    );

    expect(viaApi.id).toBe(viaService.id);
  });

  it('resumes the same thread the MCP tool opens for the same scope', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const a = await makeItem(caller, 'a');
    const b = await makeItem(caller, 'b');

    const viaApi = await json<V1PlanSession>(
      await open(caller, { targetKeys: [a.identifier, b.identifier] }),
    );
    const tool = await runOpenPlanSession(
      { projectKey: caller.projectKey, targetKeys: [b.identifier, a.identifier] },
      caller.ctx,
    );
    const payload = tool.structuredContent as Record<string, unknown>;

    expect(viaApi.id).toBe(payload['id']);
    expect(viaApi.targetKeys).toEqual(payload['targetKeys']);
    expect(viaApi.turnCount).toBe(payload['turnCount']);
  });

  it('treats the anchor set as a SET — order and duplicates do not fork it', async () => {
    // Asserted against `buildScope`, the helper the service and the repository
    // derive the key from, rather than against an assumption about either.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const a = await makeItem(caller, 'a');
    const b = await makeItem(caller, 'b');

    const sorted = await json<V1PlanSession>(
      await open(caller, { targetKeys: [a.identifier, b.identifier] }),
    );
    const shuffledWithDupe = await json<V1PlanSession>(
      await open(caller, { targetKeys: [b.identifier, a.identifier, b.identifier] }),
    );
    const lowerCased = await json<V1PlanSession>(
      await open(caller, { targetKeys: [b.identifier.toLowerCase(), a.identifier.toLowerCase()] }),
    );

    expect(shuffledWithDupe.id).toBe(sorted.id);
    expect(lowerCased.id).toBe(sorted.id);
    // …and the canonical form on the wire is the service's own.
    expect(sorted.targetKeys).toEqual(buildScope([b.identifier, a.identifier]).targetKeys);
  });

  it('keeps an ANCHORED thread distinct from the project-wide one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const anchor = await makeItem(caller, 'the anchor');

    const wide = await json<V1PlanSession>(await open(caller, {}));
    const anchored = await json<V1PlanSession>(
      await open(caller, { targetKeys: [anchor.identifier] }),
    );

    expect(anchored.id).not.toBe(wide.id);
    expect(wide.targetKeys).toEqual(PROJECT_SCOPE.targetKeys);
  });

  it('404s an anchor key that names no item, rather than anchoring at nothing', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await open(caller, { targetKeys: [`${caller.projectKey}-99999`] });

    expect(res.status).toBe(404);
  });

  it('422s an anchor set over the cap, before the resolution fan-out', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const tooMany = Array.from(
      { length: MAX_SCOPE_TARGETS + 1 },
      (_unused, i) => `${caller.projectKey}-${i + 1}`,
    );

    const res = await open(caller, { targetKeys: tooMany });

    expect(res.status).toBe(422);
    expect((await json<{ code: string }>(res)).code).toBe('PLAN_CHANGE_TOO_MANY_TARGETS');
    expect(DOMAIN_ERROR_STATUS['PLAN_CHANGE_TOO_MANY_TARGETS']).toBe(422);
  });

  it('404s a project in another workspace; 403s a token with no `read`', async () => {
    const mine = await createV1ProjectCaller({ scopes: ['read'] });
    const theirs = await createV1ProjectCaller({ scopes: ['read'], identifier: 'OTHR' });

    expect((await open(mine, {}, theirs.projectKey)).status).toBe(404);
    const noScope = await createV1ProjectCaller({ scopes: ['sprints:write'] });
    expect((await open(noScope)).status).toBe(403);
  });
});

describe('POST …/plan-session/turns', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('persists the turn and starts NO job, spends NO credits, changes NO work item', async () => {
    // The contract every client depends on: an append that looked like a submit
    // would have an agent polling a job that was never created.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const item = await makeItem(caller, 'untouched');

    const res = await append(caller, { body: 'split the billing epic' });

    expect(res.status).toBe(200);
    const body = await json<V1PlanSession>(res);
    expect(() => planSessionSchema.parse(body)).not.toThrow();
    expect(body.turnCount).toBe(1);
    expect(body.turns[0]?.role).toBe('user');
    expect(body.turns[0]?.body).toBe('split the billing epic');
    expect(body.lastSubmittedAt).toBeNull();
    expect(body.lastJobId).toBeNull();
    // Nothing was sent to the planner…
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
    // …and the work item is exactly as it was.
    const after = await workItemsService.getWorkItem(item.id, caller.ctx);
    expect(after.title).toBe('untouched');
    expect(after.status).toBe('todo');
  });

  it('ACCUMULATES turns in order across calls', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });

    await append(caller, { body: 'add auth to the billing epic' });
    const body = await json<V1PlanSession>(
      await append(caller, { body: 'keep them under 3 points' }),
    );

    expect(body.turns.map((t) => t.body)).toEqual([
      'add auth to the billing epic',
      'keep them under 3 points',
    ]);
    expect(body.turns.map((t) => t.seq)).toEqual([0, 1]);
  });

  it('opens the thread on the first turn — appending to an unopened scope is normal', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });

    const body = await json<V1PlanSession>(await append(caller, { body: 'a first turn' }));

    expect(body.turnCount).toBe(1);
  });

  it('422s an empty body, and 403s a read-only token', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });

    expect((await append(caller, { body: '   ' })).status).toBe(422);
    expect(DOMAIN_ERROR_STATUS['PLAN_CHANGE_EMPTY_TURN']).toBe(422);

    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    expect((await append(readOnly, { body: 'nope' })).status).toBe(403);
  });
});

describe('POST …/plan-session/submissions', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('sends every turn as ONE change and returns the handle at 202', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await append(caller, { body: 'first' });
    await append(caller, { body: 'second' });
    acceptJob();

    const res = await submit(caller);

    expect(res.status).toBe(202);
    const handle = await json<V1PlanJobHandle>(res);
    expect(() => planJobHandleSchema.parse(handle)).not.toThrow();
    expect(handle.jobId).toBe('job_session');
    expect(handle.statusUrl).toBe(`/api/v1/plans/${handle.planId}/status`);
    // ONE submit, carrying BOTH turns in order.
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
    const context = vi.mocked(submitJob).mock.calls[0]?.[2] as Record<string, unknown>;
    const intent = JSON.stringify(context);
    expect(intent.indexOf('first')).toBeLessThan(intent.indexOf('second'));
  });

  it('refuses an EMPTY thread with 422, never a 500', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await open(caller);
    acceptJob();

    const res = await submit(caller);

    expect(res.status).toBe(422);
    expect((await json<{ code: string }>(res)).code).toBe('PLAN_CHANGE_EMPTY_INTENT');
    expect(DOMAIN_ERROR_STATUS['PLAN_CHANGE_EMPTY_INTENT']).toBe(422);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });

  it('leaves the thread INTACT and re-submittable after a failed submit', async () => {
    // What a client on a flaky link depends on: a failed send must not consume
    // the turns it was carrying.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await append(caller, { body: 'the intent that must survive' });
    vi.mocked(submitJob).mockRejectedValueOnce(new MotirAiUnavailableError('connect ECONNREFUSED'));

    expect((await submit(caller)).status).toBe(503);

    const after = await json<V1PlanSession>(await open(caller));
    expect(after.turnCount).toBe(1);
    expect(after.turns[0]?.body).toBe('the intent that must survive');

    // …and the retry works.
    acceptJob('job_retry');
    const retried = await submit(caller);
    expect(retried.status).toBe(202);
    expect((await json<V1PlanJobHandle>(retried)).jobId).toBe('job_retry');
  });

  it('submits the ANCHORED thread when the anchor set is given', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const anchor = await makeItem(caller, 'the anchor');
    await append(caller, { targetKeys: [anchor.identifier], body: 're-plan this' });
    await append(caller, { body: 'a project-wide thought' });
    acceptJob();

    const res = await submit(caller, { targetKeys: [anchor.identifier] });

    expect(res.status).toBe(202);
    const anchored = await json<V1PlanSession>(
      await open(caller, { targetKeys: [anchor.identifier] }),
    );
    // The submit landed on the ANCHORED thread; the project-wide one is untouched.
    expect(anchored.lastJobId).toBe('job_session');
    expect((await json<V1PlanSession>(await open(caller))).lastJobId).toBeNull();
  });

  it('403s a read-only token — a submit spends credits', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    expect((await submit(caller)).status).toBe(403);
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });
});

describe('the conversation’s contract', () => {
  it('carries the scope each MCP counterpart holds, read off the shipped map', () => {
    const byId = new Map(WORK_LOOP_OPERATIONS.map((op) => [op.operationId, op]));
    expect(byId.get('openPlanSession')?.scope).toBe(TOOL_SCOPES.open_plan_session);
    expect(byId.get('appendPlanTurn')?.scope).toBe(TOOL_SCOPES.append_plan_turn);
    expect(byId.get('submitPlanSession')?.scope).toBe(TOOL_SCOPES.submit_plan_session);
    // The mount is `read`-scoped despite being a POST — the scope mirrors the
    // CAPABILITY, never the verb.
    expect(TOOL_SCOPES.open_plan_session).toBe('read');
    expect(TOOL_SCOPES.append_plan_turn).toBe('work_items:write');
  });

  it('accepts NO session id anywhere — the thread is addressed by scope alone', () => {
    // The property that makes forking a second conversation about one anchor set
    // impossible. Asserted on the declared request bodies, so a later card
    // cannot quietly add one.
    const conversation = WORK_LOOP_OPERATIONS.filter((op) => op.path.includes('plan-session'));
    expect(conversation).toHaveLength(3);
    for (const op of conversation) {
      const declared = JSON.stringify(op.requestBody?.schema ?? {});
      expect(declared, `${op.operationId} must not take a session id`).not.toMatch(/sessionId/i);
      expect(op.parameters.map((p) => p.name)).toEqual(['projectKey']);
    }
  });
});
