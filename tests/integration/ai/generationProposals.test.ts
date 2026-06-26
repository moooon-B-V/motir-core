import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — the internal incremental-proposals seam (Subtask 7.4.4 ·
// MOTIR-846) end-to-end through the REAL route, against a real Postgres. It is
// the replacement for the removed whole-delta `plan-delta`. Proves: job-token
// auth (§4a + §4b), the append of `add` PlanItems to the job's Plan via the 7.21
// addProposals (NO WorkItem created, no status set), the created-id ECHO in append
// order (the handler's temp-ref keys), `final: true` marking the plan `planned`,
// and the 404-not-403 cross-tenant / no-plan-for-job posture.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

function tokenFor(fx: { ctx: { userId: string; workspaceId: string }; projectId: string }): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function proposalsReq(opts: { bearer?: string; token?: string; body: unknown }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/plan-proposals', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
}

/** Open a `generating` plan bound to `jobId` (what the generate seam does). */
async function openPlan(
  fx: { ctx: { userId: string; workspaceId: string }; projectId: string },
  jobId: string,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  return plan.id;
}

describe('POST /api/internal/ai/plan-proposals — incremental generation seam', () => {
  it('appends add proposals to the job plan, creates NO WorkItem, echoes ids in append order', async () => {
    const fx = await makeFixture();
    const jobId = 'job_gen_append';
    const planId = await openPlan(fx, jobId);

    const res = await proposalsPOST(
      proposalsReq({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          jobId,
          proposals: [
            { op: 'add', proposedFields: { title: 'Epic: Auth', kind: 'epic' } },
            { op: 'add', proposedFields: { title: 'Story: Login', kind: 'story' } },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.planId).toBe(planId);
    expect(body.planned).toBe(false);
    expect(body.planItemIds).toHaveLength(2);

    // The ids ARE the appended PlanItems, in append order (epic then story).
    const items = await planItemRepository.findByPlan(planId);
    expect(items.map((i) => i.id)).toEqual(body.planItemIds);
    expect(items.every((i) => i.op === 'add' && i.workItemId === null)).toBe(true);
    expect((items[0]!.proposedFields as { title: string }).title).toBe('Epic: Auth');

    // Generation NEVER materializes — no work item exists yet.
    const workItems = await db.workItem.count({ where: { projectId: fx.projectId } });
    expect(workItems).toBe(0);
  });

  it('supports intra-plan temp-refs: a child add references the echoed parent id', async () => {
    const fx = await makeFixture();
    const jobId = 'job_gen_refs';
    const planId = await openPlan(fx, jobId);

    // First batch: an epic. The handler reuses its echoed id as a temp-ref.
    const r1 = await proposalsPOST(
      proposalsReq({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          jobId,
          proposals: [{ op: 'add', proposedFields: { title: 'Epic', kind: 'epic' } }],
        },
      }),
    );
    const epicPlanItemId = (await r1.json()).planItemIds[0];

    // Second batch: a story under that epic via the temp-ref.
    const r2 = await proposalsPOST(
      proposalsReq({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          jobId,
          proposals: [
            {
              op: 'add',
              proposedFields: { title: 'Story', kind: 'story' },
              parentRef: `planItem:${epicPlanItemId}`,
            },
          ],
          final: true,
        },
      }),
    );
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.planned).toBe(true);

    const items = await planItemRepository.findByPlan(planId);
    const story = items.find((i) => (i.proposedFields as { title?: string })?.title === 'Story');
    expect(story!.parentRef).toBe(`planItem:${epicPlanItemId}`);

    // `final: true` moved the plan generating → planned.
    const plan = await db.plan.findFirst({ where: { id: planId } });
    expect(plan!.status).toBe('planned');
  });

  it('a final-only call (no proposals) marks the plan planned and echoes no ids', async () => {
    const fx = await makeFixture();
    const jobId = 'job_gen_finalonly';
    const planId = await openPlan(fx, jobId);

    const res = await proposalsPOST(
      proposalsReq({ bearer: SERVICE_SECRET, token: tokenFor(fx), body: { jobId, final: true } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.planItemIds).toEqual([]);
    expect(body.planned).toBe(true);
    const plan = await db.plan.findFirst({ where: { id: planId } });
    expect(plan!.status).toBe('planned');
  });

  it('401s a missing service bearer (before any DB work)', async () => {
    const fx = await makeFixture();
    const res = await proposalsPOST(
      proposalsReq({ token: tokenFor(fx), body: { jobId: 'x', proposals: [] } }),
    );
    expect(res.status).toBe(401);
  });

  it('404s a job with no plan in the token tenant (NoPlanForJobError, no 403 leak)', async () => {
    const fx = await makeFixture();
    const res = await proposalsPOST(
      proposalsReq({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          jobId: 'job_never_opened',
          proposals: [{ op: 'add', proposedFields: { title: 'x' } }],
        },
      }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_PLAN_FOR_JOB' });
  });

  it('404s a cross-tenant token (a foreign job-token cannot reach the plan)', async () => {
    const a = await makeFixture();
    const b = await makeFixture(); // different workspace + project
    const jobId = 'job_tenant_a';
    await openPlan(a, jobId); // the plan lives in tenant A

    // B's user holds a token for B's tenant but names A's job — the workspace-scoped
    // lookup finds no plan, so it's a 404, never a 403 that leaks A's plan exists.
    const res = await proposalsPOST(
      proposalsReq({
        bearer: SERVICE_SECRET,
        token: tokenFor(b),
        body: { jobId, proposals: [{ op: 'add', proposedFields: { title: 'x' } }] },
      }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_PLAN_FOR_JOB' });
  });

  it('400s a body with no jobId', async () => {
    const fx = await makeFixture();
    const res = await proposalsPOST(
      proposalsReq({ bearer: SERVICE_SECRET, token: tokenFor(fx), body: { proposals: [] } }),
    );
    expect(res.status).toBe(400);
  });
});
