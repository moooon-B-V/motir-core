import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { POST as stepPOST } from '@/app/api/internal/ai/plan-step/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-7820 · Subtask MOTIR-7824) — the hosted planner's
// door, `POST /api/internal/ai/plan-step`, end-to-end through the REAL route
// against a real Postgres.
//
// The step store's own rules are proven in `tests/integration/plans/planSteps.test.ts`.
// What is asserted here is the TRANSPORT: the §4a-bearer + §4b-job-token auth,
// the job-resolved plan and its `planId` cross-check, the body-shape 400s, and
// the status each typed refusal maps to — so motir-ai's walk can match a code and
// carry on, and never meets a 500 for an advisory signal.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function tokenFor(fx: { ctx: { userId: string; workspaceId: string } }, projectId: string): string {
  return mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId });
}

function req(opts: { bearer?: string; token?: string; body?: unknown; raw?: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/plan-step', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

/** A `generating` plan bound to `jobId`, carrying one `add` — what a walk reports on. */
async function generatingPlan(fx: Fx, jobId: string): Promise<{ planId: string; addId: string }> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The surface', kind: 'story' } }],
    fx.ctx,
  );
  return { planId: plan.id, addId: appended.appendedItemIds[0]! };
}

/** The happy-path call: the fixture's own token, the fixture's own job. */
function report(fx: Fx, jobId: string, body: Record<string, unknown>) {
  return stepPOST(
    req({ bearer: SERVICE_SECRET, token: tokenFor(fx, fx.projectId), body: { jobId, ...body } }),
  );
}

const steps = (planId: string, fx: Fx) =>
  planReviewService.getPlanReview(planId, fx.ctx).then((r) => r.inFlightSteps ?? []);

describe('POST /api/internal/ai/plan-step — what it records', () => {
  it('records each of the four steps on the job’s generating plan', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_happy';
    const { planId, addId } = await generatingPlan(fx, jobId);

    const settle = await report(fx, jobId, { sessionKey: 'settle', step: 'settle' });
    expect(settle.status).toBe(200);
    const settleBody = (await settle.json()) as {
      planId: string;
      step: string;
      inFlight: { sessionKey: string; kind: string; targetRef: string | null; startedAt: string };
    };
    expect(settleBody).toMatchObject({ planId, step: 'settle', inFlight: { kind: 'settle' } });

    const lay = await report(fx, jobId, {
      sessionKey: 'lay-1',
      step: 'lay',
      target: `planItem:${addId}`,
    });
    expect(lay.status).toBe(200);

    const author = await report(fx, jobId, {
      planId,
      sessionKey: 'author-1',
      step: 'author',
      target: `planItem:${addId}`,
    });
    expect(author.status).toBe(200);

    const live = await steps(planId, fx);
    expect(live.map((s) => [s.sessionKey, s.kind, s.targetRef])).toEqual(
      expect.arrayContaining([
        ['settle', 'settle', null],
        ['lay-1', 'lay', `planItem:${addId}`],
        ['author-1', 'author', `planItem:${addId}`],
      ]),
    );
    // The stored time is the one the route hands back.
    expect(live.find((s) => s.sessionKey === 'settle')!.startedAt).toBe(
      settleBody.inFlight.startedAt,
    );

    const end = await report(fx, jobId, { sessionKey: 'author-1', step: 'end' });
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({ planId, step: 'end', inFlight: null });
    expect((await steps(planId, fx)).map((s) => s.sessionKey).sort()).toEqual(['lay-1', 'settle']);

    // A repeated `end` is still a success.
    const again = await report(fx, jobId, { sessionKey: 'author-1', step: 'end' });
    expect(again.status).toBe(200);
  });

  it.each(['lay', 'author'] as const)(
    'accepts an untargeted `%s`, stored as `targetRef: null`',
    async (step) => {
      const fx = await makeFixture();
      const jobId = `job_step_untargeted_${step}`;
      const { planId } = await generatingPlan(fx, jobId);

      const res = await report(fx, jobId, { sessionKey: `u-${step}`, step });
      expect(res.status).toBe(200);
      expect(await steps(planId, fx)).toEqual([
        expect.objectContaining({ sessionKey: `u-${step}`, kind: step, targetRef: null }),
      ]);
    },
  );
});

describe('auth and the no-leak posture', () => {
  it('401 without the service bearer, with a wrong one, and without the job token', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_auth';
    const { planId } = await generatingPlan(fx, jobId);
    const body = { jobId, sessionKey: 's', step: 'settle' };

    expect((await stepPOST(req({ token: tokenFor(fx, fx.projectId), body }))).status).toBe(401);
    expect(
      (await stepPOST(req({ bearer: 'not-the-secret', token: tokenFor(fx, fx.projectId), body })))
        .status,
    ).toBe(401);
    expect((await stepPOST(req({ bearer: SERVICE_SECRET, body }))).status).toBe(401);
    expect(
      (await stepPOST(req({ bearer: SERVICE_SECRET, token: 'not.a.token', body }))).status,
    ).toBe(401);
    expect(await steps(planId, fx)).toHaveLength(0);
  });

  it('a token from ANOTHER workspace → 404, and writes nothing', async () => {
    const fx = await makeFixture();
    const other = await makeFixture({ name: 'Other', identifier: 'OTHR' });
    const jobId = 'job_step_cross_tenant';
    const { planId } = await generatingPlan(fx, jobId);

    const res = await stepPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(other, other.projectId),
        body: { jobId, sessionKey: 's', step: 'settle' },
      }),
    );
    expect(res.status).toBe(404);
    expect(await steps(planId, fx)).toHaveLength(0);
  });

  it('a `planId` that is not the job’s plan is answered like a foreign job → 404', async () => {
    const fx = await makeFixture();
    const mine = await generatingPlan(fx, 'job_step_mine');
    const theirs = await generatingPlan(fx, 'job_step_theirs');

    const res = await report(fx, 'job_step_mine', {
      planId: theirs.planId,
      sessionKey: 's',
      step: 'settle',
    });
    expect(res.status).toBe(404);
    expect(await steps(mine.planId, fx)).toHaveLength(0);
    expect(await steps(theirs.planId, fx)).toHaveLength(0);
  });

  it('a job with no plan → 404', async () => {
    const fx = await makeFixture();
    const res = await report(fx, 'job_that_opened_no_plan', { sessionKey: 's', step: 'settle' });
    expect(res.status).toBe(404);
  });
});

describe('the refusals, and the codes motir-ai branches on', () => {
  it('400 PLAN_STEP_INVALID on a malformed body', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_400';
    await generatingPlan(fx, jobId);
    const token = tokenFor(fx, fx.projectId);

    const badJson = await stepPOST(req({ bearer: SERVICE_SECRET, token, raw: '{not json' }));
    expect(badJson.status).toBe(400);

    const noJob = await stepPOST(
      req({ bearer: SERVICE_SECRET, token, body: { sessionKey: 's', step: 'settle' } }),
    );
    expect(noJob.status).toBe(400);

    for (const body of [
      { sessionKey: 7, step: 'settle' },
      { step: 'settle' },
      { sessionKey: 's', step: 'daydream' },
      { sessionKey: 's', step: 'lay', target: 12 },
      { sessionKey: 's', step: 'lay', planId: 12 },
    ]) {
      const res = await report(fx, jobId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
  });

  it.each(['planned', 'approved', 'declined'] as const)(
    '409 PLAN_NOT_GENERATING on a `%s` plan, and nothing moves',
    async (status) => {
      const fx = await makeFixture();
      const jobId = `job_step_409_${status}`;
      const { planId } = await generatingPlan(fx, jobId);
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      const before = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });

      const res = await report(fx, jobId, { sessionKey: 's', step: 'lay' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_NOT_GENERATING');

      expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
      const after = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      expect(after.lastActivityAt.toISOString()).toBe(before.lastActivityAt.toISOString());
    },
  );

  it('422 PLAN_STEP_INVALID on a step the store refuses', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_422';
    const { planId, addId } = await generatingPlan(fx, jobId);

    for (const body of [
      { sessionKey: 's', step: 'settle', target: `planItem:${addId}` },
      { sessionKey: 's', step: 'end', target: `planItem:${addId}` },
      { sessionKey: 's', step: 'author', target: 'planItem:nothing-here' },
      { sessionKey: 's', step: 'lay', target: 'folder:anything' },
      { sessionKey: '', step: 'settle' },
    ]) {
      const res = await report(fx, jobId, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
  });
});
