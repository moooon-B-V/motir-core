import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { NATIVE_PLANNER_HARNESS } from '@/lib/ai/plannerTenantBug';
import { REASON_CLASSIFIED_KIND, REVISION_REASON_EVIDENCE_MAX } from '@/lib/plans/revisionReason';
import { POST as reasonPOST } from '@/app/api/internal/ai/plan-revision-reason/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-5543 · Subtask MOTIR-6087) — the shipped planner's
// door, `POST /api/internal/ai/plan-revision-reason`, end-to-end through the
// REAL route against a real Postgres.
//
// It proves four things the service's own units cannot reach, because each is a
// property of the TRANSPORT:
//   · every branch records, attributed to the NATIVE planner with the job's model;
//   · the §4a-bearer + §4b-job-token auth, and the family's 404-not-403
//     cross-tenant posture;
//   · a `planId` that is not the job's plan is answered like a foreign job —
//     the cross-check leaks nothing;
//   · the refusals map to the status codes motir-ai branches on, with a
//     machine-readable code.
//
// The ROW is read through `adminDb` rather than through any tenant read, for the
// reason the whole card exists: no tenant read returns a classification, so a
// test that looked for one through `listByPlan` would assert an absence it gets
// for free.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
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
  return new Request('http://core/api/internal/ai/plan-revision-reason', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

/** A `planned` plan bound to `jobId` — the state a REVISE_PLAN pass acts on. */
async function plannedPlan(fx: Fx, jobId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The surface', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** The happy-path call: the fixture's own token, the fixture's own job. */
function record(fx: Fx, jobId: string, body: Record<string, unknown>) {
  return reasonPOST(
    req({ bearer: SERVICE_SECRET, token: tokenFor(fx, fx.projectId), body: { jobId, ...body } }),
  );
}

const classifications = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: REASON_CLASSIFIED_KIND },
    orderBy: { changedAt: 'asc' },
  });

describe('POST /api/internal/ai/plan-revision-reason — what it records', () => {
  it.each([
    ['new_ask', false],
    ['different_solution', false],
    ['rule_gap', true],
    ['rule_not_followed', true],
  ] as const)('records `%s` → 201, attributed to the native planner', async (branch, filesABug) => {
    const fx = await makeFixture();
    const jobId = `job_reason_${branch}`;
    const planId = await plannedPlan(fx, jobId);
    const bug = filesABug
      ? await workItemsService.createWorkItem(
          { projectId: fx.projectId, kind: 'bug', title: 'Planning bug: the check nobody made' },
          fx.ctx,
        )
      : null;

    const res = await record(fx, jobId, {
      branch,
      evidenceMd: 'The conversation never raised it; the rule search came back empty.',
      planningBugId: bug?.id ?? null,
      model: 'deepseek-v4-pro',
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { revisionId: string; planId: string; branch: string };
    expect(json.planId).toBe(planId);
    expect(json.branch).toBe(branch);

    const rows = await classifications(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(json.revisionId);
    expect(rows[0]!.diff).toEqual({ branch, planningBugId: bug?.id ?? null });
    expect(rows[0]!.noteMd).toBe(
      'The conversation never raised it; the rule search came back empty.',
    );
    expect(rows[0]!.planItemId).toBeNull();
    // The NATIVE planning triple — the internal record says MOTIR classified it.
    expect(rows[0]!.actorSource).toBe('native');
    expect(rows[0]!.actorHarness).toBe(NATIVE_PLANNER_HARNESS);
    expect(rows[0]!.actorModel).toBe('deepseek-v4-pro');
  });

  it('accepts the job’s own `planId` as a cross-check', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_planid_ok';
    const planId = await plannedPlan(fx, jobId);

    const res = await record(fx, jobId, {
      planId,
      branch: 'new_ask',
      evidenceMd: 'Nobody raised export.',
    });
    expect(res.status).toBe(201);
    expect(await classifications(planId)).toHaveLength(1);
  });

  it('records on a plan that is still `generating`, not only a `planned` one', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_generating';
    const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);

    const res = await record(fx, jobId, {
      branch: 'different_solution',
      evidenceMd: 'They prefer a side panel.',
    });
    expect(res.status).toBe(201);
    expect(await classifications(plan.id)).toHaveLength(1);
  });
});

describe('auth and the no-leak posture', () => {
  it('401 without the service bearer, and 401 without the job token', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_auth';
    await plannedPlan(fx, jobId);
    const body = { jobId, branch: 'new_ask', evidenceMd: 'e' };

    const noBearer = await reasonPOST(req({ token: tokenFor(fx, fx.projectId), body }));
    expect(noBearer.status).toBe(401);

    const noToken = await reasonPOST(req({ bearer: SERVICE_SECRET, body }));
    expect(noToken.status).toBe(401);

    const wrongBearer = await reasonPOST(
      req({ bearer: 'not-the-secret', token: tokenFor(fx, fx.projectId), body }),
    );
    expect(wrongBearer.status).toBe(401);
  });

  it('a token from ANOTHER workspace cannot record on this plan → 404, and writes nothing', async () => {
    const fx = await makeFixture();
    const other = await makeFixture({ name: 'Other', identifier: 'OTHR' });
    const jobId = 'job_reason_cross_tenant';
    const planId = await plannedPlan(fx, jobId);

    const res = await reasonPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(other, other.projectId),
        body: { jobId, branch: 'new_ask', evidenceMd: 'Not yours.' },
      }),
    );

    // 404, not 403: the family's posture is that another tenant's plan is
    // INVISIBLE rather than forbidden.
    expect(res.status).toBe(404);
    expect(await classifications(planId)).toHaveLength(0);
  });

  it('a `planId` that is not the job’s plan is answered like a foreign job → 404', async () => {
    const fx = await makeFixture();
    const mine = 'job_reason_mine';
    const theirs = 'job_reason_theirs';
    const minePlan = await plannedPlan(fx, mine);
    const theirsPlan = await plannedPlan(fx, theirs);

    const res = await record(fx, mine, {
      planId: theirsPlan,
      branch: 'new_ask',
      evidenceMd: 'Guessed an id.',
    });

    expect(res.status).toBe(404);
    // Neither plan gained a row — the cross-check refuses rather than redirecting.
    expect(await classifications(minePlan)).toHaveLength(0);
    expect(await classifications(theirsPlan)).toHaveLength(0);
  });

  it('a job with no plan → 404', async () => {
    const fx = await makeFixture();
    const res = await record(fx, 'job_that_opened_no_plan', {
      branch: 'new_ask',
      evidenceMd: 'Nothing to classify.',
    });
    expect(res.status).toBe(404);
  });
});

describe('the refusals, and the codes motir-ai branches on', () => {
  it('400 on a malformed body — bad JSON, no `jobId`, an unknown branch, no evidence', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_400';
    await plannedPlan(fx, jobId);
    const token = tokenFor(fx, fx.projectId);

    const badJson = await reasonPOST(req({ bearer: SERVICE_SECRET, token, raw: '{not json' }));
    expect(badJson.status).toBe(400);

    const noJob = await reasonPOST(
      req({ bearer: SERVICE_SECRET, token, body: { branch: 'new_ask', evidenceMd: 'e' } }),
    );
    expect(noJob.status).toBe(400);

    const badBranch = await record(fx, jobId, { branch: 'because_i_said_so', evidenceMd: 'e' });
    expect(badBranch.status).toBe(400);
    const badBranchBody = (await badBranch.json()) as { code: string; error: string };
    expect(badBranchBody.code).toBe('PLAN_REVISION_REASON_INVALID');
    // The vocabulary rides in the message so the pass can correct itself.
    expect(badBranchBody.error).toContain('rule_not_followed');

    const noEvidence = await record(fx, jobId, { branch: 'new_ask', evidenceMd: '   ' });
    expect(noEvidence.status).toBe(400);
  });

  it('409 on a DECIDED plan, with its code', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_409';
    const planId = await plannedPlan(fx, jobId);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });

    const res = await record(fx, jobId, { branch: 'new_ask', evidenceMd: 'Too late.' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_NOT_EDITABLE');
  });

  it('422 on a branch / bug pairing that contradicts itself, carrying the branch as data', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_422';
    const planId = await plannedPlan(fx, jobId);
    const bug = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'Planning bug: somewhere' },
      fx.ctx,
    );

    // A rule branch with no bug.
    const missing = await record(fx, jobId, {
      branch: 'rule_gap',
      evidenceMd: 'No rule covers it.',
    });
    expect(missing.status).toBe(422);
    const missingBody = (await missing.json()) as { code: string; branch: string };
    expect(missingBody.code).toBe('PLAN_REVISION_CLASSIFICATION_INVALID');
    expect(missingBody.branch).toBe('rule_gap');

    // A no-bug branch carrying one.
    const stray = await record(fx, jobId, {
      branch: 'different_solution',
      evidenceMd: 'They prefer a panel.',
      planningBugId: bug.id,
    });
    expect(stray.status).toBe(422);
    expect(((await stray.json()) as { branch: string }).branch).toBe('different_solution');

    expect(await classifications(planId)).toHaveLength(0);
  });

  it('422 when the evidence is past its bound', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_evidence';
    await plannedPlan(fx, jobId);

    const res = await record(fx, jobId, {
      branch: 'new_ask',
      evidenceMd: 'x'.repeat(REVISION_REASON_EVIDENCE_MAX + 1),
    });
    expect(res.status).toBe(422);
  });

  it('422 when the `planningBugId` is not a bug', async () => {
    const fx = await makeFixture();
    const jobId = 'job_reason_not_a_bug';
    await plannedPlan(fx, jobId);
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A task' },
      fx.ctx,
    );

    const res = await record(fx, jobId, {
      branch: 'rule_not_followed',
      evidenceMd: 'The pack asked for it.',
      planningBugId: task.id,
    });
    expect(res.status).toBe(422);
  });
});
