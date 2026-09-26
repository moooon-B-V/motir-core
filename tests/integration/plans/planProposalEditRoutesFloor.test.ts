import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// The COVERAGE FLOOR half of MOTIR-6141 (story MOTIR-6095's motir-core gate) for
// the two proposal-edit routes the story changed:
//
//   • `app/api/plans/[id]/items/[itemId]/route.ts`          — the human door
//   • `app/api/internal/ai/plan-proposals/[itemId]/route.ts` — motir-ai's door
//
// The story's round trips live in `planDifficultyStoryGate.test.ts`; the
// routes' difficulty parsing in `publicProposalPatchDifficulty.test.ts` and
// `tests/integration/ai/planRevisionRoutes.test.ts`. What is here is the
// transport around them that no spec reached: the body guards, the
// wrong-typed-value → `null` convention on every picked key, and each typed
// refusal's status. Real Postgres; the session and its workspace-context twin
// are the `publicProposalPatchTodos.test.ts` carve-out.

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
const { PATCH: internalPATCH, DELETE: internalDELETE } =
  await import('@/app/api/internal/ai/plan-proposals/[itemId]/route');

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  activeCtx.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signIn(fx: WorkItemFixture, userId = fx.ctx.userId): void {
  activeCtx.current = {
    userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  } as ProjectContext;
}

function human(planId: string, itemId: string, raw: string): Promise<Response> {
  return humanPATCH(
    new Request(`http://core/api/plans/${planId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw,
    }),
    { params: Promise.resolve({ id: planId, itemId }) },
  );
}

interface JobOpts {
  token?: boolean;
  /** The job token's user — the fixture's owner unless a test says otherwise. */
  userId?: string;
}

function jobRequest(
  fx: WorkItemFixture,
  url: string,
  init: RequestInit,
  { token = true, userId = fx.ctx.userId }: JobOpts = {},
): Request {
  const req = new Request(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
  });
  if (token) {
    req.headers.set(
      'x-motir-job-token',
      mintJobToken({
        userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    );
  }
  return req;
}

function internal(
  fx: WorkItemFixture,
  itemId: string,
  raw: string,
  opts?: JobOpts,
): Promise<Response> {
  return internalPATCH(
    jobRequest(
      fx,
      `http://core/api/internal/ai/plan-proposals/${itemId}`,
      { method: 'PATCH', body: raw },
      opts,
    ),
    { params: Promise.resolve({ itemId }) },
  );
}

function withdraw(
  fx: WorkItemFixture,
  itemId: string,
  query: string,
  opts?: JobOpts,
): Promise<Response> {
  return internalDELETE(
    jobRequest(
      fx,
      `http://core/api/internal/ai/plan-proposals/${itemId}${query}`,
      { method: 'DELETE' },
      opts,
    ),
    { params: Promise.resolve({ itemId }) },
  );
}

async function planWithAdd(
  fx: WorkItemFixture,
  { planned, jobId }: { planned: boolean; jobId?: string },
): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Floor', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A card', kind: 'task', difficulty: 'low' } }],
    fx.ctx,
  );
  if (planned) await plansService.markPlanned(plan.id, fx.ctx);
  if (jobId) await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

/**
 * A second workspace member, holding `role` on the fixture's project — or no
 * project membership at all when `role` is null.
 */
async function colleague(fx: WorkItemFixture, role: 'viewer' | null): Promise<string> {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  if (role) {
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role,
    });
  }
  return user.id;
}

async function fieldsOf(itemId: string): Promise<Record<string, unknown>> {
  return (await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } }))
    .proposedFields as Record<string, unknown>;
}

// Every picked key sent with the WRONG type — the parsers' shared convention is
// that a present-but-wrong-typed value becomes `null` (a clear), never a pass-
// through and never an error of the transport's own.
const WRONG_TYPED = {
  descriptionMd: 1,
  type: 1,
  priority: 1,
  storyPoints: 'three',
  estimateMinutes: 'ten',
  difficulty: 7,
  todos: 'not a list',
};

describe('PATCH /api/plans/[id]/items/[itemId] — the transport around the edit', () => {
  it('401 without a session', async () => {
    const res = await human('p', 'i', '{}');
    expect(res.status).toBe(401);
  });

  it('400 INVALID_BODY for a body that is not JSON, and for JSON that is not an object', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    expect((await human('p', 'i', '{nope')).status).toBe(400);
    const notObject = await human('p', 'i', 'null');
    expect(notObject.status).toBe(400);
    expect(await notObject.json()).toEqual({ code: 'INVALID_BODY' });
  });

  it('a wrong-typed value on every picked key CLEARS it; title and kind ride as strings', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx, { planned: true });
    signIn(fx);

    // `priority` rides on its own call below, so each assertion names one arm.
    const { priority: _p, ...rest } = WRONG_TYPED;
    void _p;
    const res = await human(
      planId,
      itemId,
      JSON.stringify({ ...rest, title: 'Renamed', kind: 'bug' }),
    );
    expect(res.status).toBe(200);
    expect(await fieldsOf(itemId)).toMatchObject({
      title: 'Renamed',
      kind: 'bug',
      descriptionMd: null,
      type: null,
      storyPoints: null,
      estimateMinutes: null,
      difficulty: null,
      todos: null,
    });

    const priority = await human(planId, itemId, JSON.stringify({ priority: 1 }));
    expect(priority.status).toBe(200);

    // And the well-typed twin of each: every value rides through as sent.
    const valid = await human(
      planId,
      itemId,
      JSON.stringify({
        descriptionMd: 'The body.',
        type: 'code',
        priority: 'high',
        storyPoints: 3,
        estimateMinutes: 30,
        difficulty: 'high',
        todos: [{ text: 'One step' }],
      }),
    );
    expect(valid.status).toBe(200);
    expect(await fieldsOf(itemId)).toMatchObject({
      descriptionMd: 'The body.',
      type: 'code',
      priority: 'high',
      storyPoints: 3,
      estimateMinutes: 30,
      difficulty: 'high',
      todos: [{ text: 'One step' }],
    });
  });

  it('404 for an item the plan does not hold, and for an outsider (the plan gate)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx, { planned: true });
    signIn(fx);
    expect((await human(planId, 'no-such-item', '{"title":"x"}')).status).toBe(404);
    expect((await human('no-such-plan', itemId, '{"title":"x"}')).status).toBe(404);

    const outsider = await createTestUser();
    signIn(fx, outsider.id);
    expect((await human(planId, itemId, '{"title":"x"}')).status).toBe(404);
  });

  it('409 when the plan is not `planned`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx, { planned: false });
    signIn(fx);
    const res = await human(planId, itemId, JSON.stringify({ difficulty: 'high' }));
    expect(res.status).toBe(409);
    expect(await fieldsOf(itemId)).toMatchObject({ difficulty: 'low' });
  });
});

describe('PATCH /api/internal/ai/plan-proposals/[itemId] — the transport around the edit', () => {
  it('refuses a request with no job token before reading the body', async () => {
    const fx = await makeWorkItemFixture();
    const res = await internal(fx, 'i', '{}', { token: false });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('400 PROPOSALS_INVALID for a non-JSON body, a non-object body, and a missing jobId', async () => {
    const fx = await makeWorkItemFixture();
    for (const raw of ['{nope', '"a string"', '{}']) {
      const res = await internal(fx, 'i', raw);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PROPOSALS_INVALID');
    }
  });

  it('the DEEPEN: a wrong-typed value on every picked key clears it', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithAdd(fx, { planned: false, jobId: 'job-floor-deepen' });
    const { priority: _p, ...rest } = WRONG_TYPED;
    void _p;

    const res = await internal(
      fx,
      itemId,
      JSON.stringify({
        jobId: 'job-floor-deepen',
        patch: { ...rest, explanationMd: 1, executor: 1 },
      }),
    );
    expect(res.status).toBe(200);
    expect(await fieldsOf(itemId)).toMatchObject({
      descriptionMd: null,
      type: null,
      storyPoints: null,
      estimateMinutes: null,
      difficulty: null,
      explanationMd: null,
      executor: null,
      todos: null,
    });

    const priority = await internal(
      fx,
      itemId,
      JSON.stringify({ jobId: 'job-floor-deepen', patch: { priority: 1 } }),
    );
    expect(priority.status).toBe(200);
  });

  it('404 for a job with no plan, and 409 for a deepen of a plan that is no longer generating', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithAdd(fx, { planned: true, jobId: 'job-floor-closed' });

    const noPlan = await internal(fx, itemId, JSON.stringify({ jobId: 'job-nobody', patch: {} }));
    expect(noPlan.status).toBe(404);

    const closed = await internal(
      fx,
      itemId,
      JSON.stringify({ jobId: 'job-floor-closed', patch: { difficulty: 'high' } }),
    );
    expect(closed.status).toBe(409);
    expect(await fieldsOf(itemId)).toMatchObject({ difficulty: 'low' });
  });

  it('the CORRECTION reads each structural key by presence, and a dangling folder ref is a typed 422 with its reason', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithAdd(fx, { planned: true, jobId: 'job-floor-correct' });

    // Wrong-typed structural keys: `parentRef` / `targetRepo` / `subject` clear,
    // a non-string list member is dropped (so `[1]` replaces with `[]`). The
    // repo spellings go one per call — the service refuses more than one in a
    // single correction.
    const statuses: number[] = [];
    for (const repoKey of [
      { targetRepo: 1 },
      { targetRepos: [1] },
      { targetRepositories: [1] },
      { targetRepositoryRef: 1 },
    ]) {
      const res = await internal(
        fx,
        itemId,
        JSON.stringify({
          jobId: 'job-floor-correct',
          mode: 'correct',
          parentRef: 1,
          blockedByRefs: [],
          subject: 1,
          ...repoKey,
          patch: { difficulty: 'medium' },
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(await fieldsOf(itemId)).toMatchObject({ difficulty: 'medium' });

    // A non-object `modifyPatch` reads as `null`; on an `add` (which carries no
    // patch) the service refuses it — a typed 422, not a 500.
    const modifyPatch = await internal(
      fx,
      itemId,
      JSON.stringify({ jobId: 'job-floor-correct', mode: 'correct', modifyPatch: 'nope' }),
    );
    expect(modifyPatch.status).toBe(422);
    expect(((await modifyPatch.json()) as { code: string }).code).toBe('INVALID_PROPOSAL');

    const dangling = await internal(
      fx,
      itemId,
      JSON.stringify({
        jobId: 'job-floor-correct',
        mode: 'correct',
        parentRef: 'folder:does-not-exist',
      }),
    );
    expect(dangling.status).toBe(422);
    const body = (await dangling.json()) as { code: string; reason?: string };
    expect(body.reason).toBeDefined();
  });
});

describe('DELETE /api/internal/ai/plan-proposals/[itemId] — the withdraw', () => {
  it('400 without a jobId, 404 for a job with no plan, 409 once the plan is approved', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx, { planned: true, jobId: 'job-floor-del' });

    const unauthenticated = await withdraw(fx, itemId, '?jobId=job-floor-del', { token: false });
    expect(unauthenticated.status).toBeGreaterThanOrEqual(400);
    expect(unauthenticated.status).toBeLessThan(500);
    expect((await withdraw(fx, itemId, '')).status).toBe(400);
    expect((await withdraw(fx, itemId, '?jobId=job-nobody')).status).toBe(404);

    await plansService.approvePlan(planId, fx.ctx);
    const res = await withdraw(fx, itemId, '?jobId=job-floor-del');
    expect(res.status).toBe(409);
    expect(await adminDb.planItem.count({ where: { id: itemId } })).toBe(1);
  });
});

// MOTIR-6153 — two refusals the service raises that this route let escape as a
// 500. motir-ai reads a 500 as a server fault and retries it; a typed 4xx tells
// it the CALL was refused. The human route has answered the gate's refusal as a
// 403 naming the key since MOTIR-2291, and a viewer's job token must get the same.
describe('/api/internal/ai/plan-proposals/[itemId] — typed refusals, never a 500', () => {
  it("a viewer's job token is refused with the gate's 403 naming the key, on the deepen, the correction and the withdraw", async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithAdd(fx, { planned: false, jobId: 'job-viewer' });
    const viewerId = await colleague(fx, 'viewer');

    const responses = [
      await internal(
        fx,
        itemId,
        JSON.stringify({ jobId: 'job-viewer', patch: { difficulty: 'high' } }),
        { userId: viewerId },
      ),
      await internal(
        fx,
        itemId,
        JSON.stringify({ jobId: 'job-viewer', mode: 'correct', patch: { difficulty: 'high' } }),
        { userId: viewerId },
      ),
      await withdraw(fx, itemId, '?jobId=job-viewer', { userId: viewerId }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'PERMISSION_DENIED',
        permission: 'ai:view_plan',
      });
    }
    // Refused, so nothing moved: the proposal is still on the plan as it was.
    expect(await fieldsOf(itemId)).toMatchObject({ difficulty: 'low' });
  });

  it('a correction naming more than one repository field is a typed 422 naming the conflict', async () => {
    const fx = await makeWorkItemFixture();
    const { itemId } = await planWithAdd(fx, { planned: true, jobId: 'job-two-repos' });

    for (const repoKeys of [
      { targetRepo: 'core', targetRepos: ['core'] },
      { targetRepos: ['core'], targetRepositories: ['repo-row'] },
      { targetRepo: 'core', targetRepositories: ['repo-row'] },
    ]) {
      const res = await internal(
        fx,
        itemId,
        JSON.stringify({ jobId: 'job-two-repos', mode: 'correct', ...repoKeys }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('CONFLICTING_TARGET_REPO_INPUT');
      expect(body.error).toMatch(/exactly ONE of targetRepo, targetRepos or targetRepositories/);
    }
  });
});
