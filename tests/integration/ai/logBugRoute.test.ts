import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planValidityService } from '@/lib/services/planValidityService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ReporterNotInWorkspaceError } from '@/lib/workItems/errors';
import {
  NATIVE_PLANNER_HARNESS,
  PLANNER_BUG_FILED_CHANGE_KIND,
  PLANNER_BUGS_PER_JOB,
} from '@/lib/ai/plannerTenantBug';
import { POST as logBugPOST } from '@/app/api/internal/ai/log-bug/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-4053 · Subtask MOTIR-4076) — the planner's
// `log_bug` sink, `POST /api/internal/ai/log-bug`, end-to-end through the REAL
// route against a real Postgres. It proves the bound
// `motir-ai/docs/decisions/planner-files-tenant-bug.md` §3 decides, ON THE
// SERVER: the KIND is fixed, the PROJECT is the token's and only the token's,
// the VOLUME is capped under the plan's row lock, and the RECORD lands on the
// item's provenance and the plan's trail — plus the §4a-bearer + §4b-job-token
// auth and the 404-not-403 cross-tenant posture the whole `/api/internal/ai/*`
// family shares.
//
// The last block is the story's own composition (MOTIR-4053), asserted where
// readiness LIVES: a bug filed here, named in a proposal's `blockedByRefs`,
// holds the proposed story out of the finishable set through the SHIPPED
// projected read (`planValidityService.validateProjectedWorkItem`, what
// motir-ai's `validate_plan` calls) until the bug closes.

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
  return new Request('http://core/api/internal/ai/log-bug', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

/** Open a `generating` plan bound to `jobId` — what the generate seam does at submit. */
async function openPlan(fx: Fx, jobId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  return plan.id;
}

/** The happy-path call: the fixture's own token, the fixture's own job. */
function file(fx: Fx, jobId: string, body: Record<string, unknown>) {
  return logBugPOST(
    req({ bearer: SERVICE_SECRET, token: tokenFor(fx, fx.projectId), body: { jobId, ...body } }),
  );
}

describe('POST /api/internal/ai/log-bug — the filing, and what it records', () => {
  it('files ONE `bug` into the token’s project as the token’s user → 201 + key', async () => {
    const fx = await makeFixture();
    const jobId = 'job_log_bug_ok';
    const planId = await openPlan(fx, jobId);

    const res = await file(fx, jobId, {
      title: 'Search ignores the archived filter',
      descriptionMd: 'Reproduced on the items list.',
      model: 'deepseek-v4-pro',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { key: string; id: string };
    expect(json.key).toMatch(/^PROD-\d+$/);

    // The row: kind fixed, project + tenant the token's, the actor the reporter,
    // at the project root, and the NATIVE planning triple stamped.
    const row = await adminDb.workItem.findUnique({ where: { id: json.id } });
    expect(row?.kind).toBe('bug');
    expect(row?.projectId).toBe(fx.projectId);
    expect(row?.workspaceId).toBe(fx.workspaceId);
    expect(row?.reporterId).toBe(fx.ownerId);
    expect(row?.parentId).toBeNull();
    expect(row?.descriptionMd).toBe('Reproduced on the items list.');
    expect(row?.planningSource).toBe('native');
    expect(row?.planningHarness).toBe(NATIVE_PLANNER_HARNESS);
    expect(row?.planningModel).toBe('deepseek-v4-pro');

    // The RECORD on the plan's trail — the row the timeline renders, naming the key.
    const trail = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(planId, tx),
    );
    const filed = trail.filter((r) => r.changeKind === PLANNER_BUG_FILED_CHANGE_KIND);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.planItemId).toBeNull();
    expect(filed[0]!.changedById).toBe(fx.ownerId);
    expect(filed[0]!.actorSource).toBe('native');
    expect(filed[0]!.actorHarness).toBe(NATIVE_PLANNER_HARNESS);
    expect(filed[0]!.actorModel).toBe('deepseek-v4-pro');
    expect(filed[0]!.diff).toEqual({
      workItemId: json.id,
      workItemKey: json.key,
      title: 'Search ignores the archived filter',
    });
  });

  it('files under a parent named by key, inside the token’s project', async () => {
    const fx = await makeFixture();
    const jobId = 'job_log_bug_parent';
    await openPlan(fx, jobId);
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Search' },
      fx.ctx,
    );

    const res = await file(fx, jobId, {
      title: 'under the story',
      parentKey: story.identifier.toLowerCase(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await adminDb.workItem.findUnique({ where: { id: json.id } });
    expect(row?.parentId).toBe(story.id);
  });

  it('a blank model and no description are stored as nulls, never as empty strings', async () => {
    const fx = await makeFixture();
    const jobId = 'job_log_bug_blank';
    await openPlan(fx, jobId);
    const res = await file(fx, jobId, { title: 'no model', model: '   ' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await adminDb.workItem.findUnique({ where: { id: json.id } });
    expect(row?.planningModel).toBeNull();
    expect(row?.descriptionMd).toBeNull();
  });
});

describe('the PROJECT bound — the token’s project, and only the token’s', () => {
  it('a job token for project A cannot file on a job whose plan is project B’s → 404 NO_PLAN_FOR_JOB', async () => {
    // Two projects in ONE workspace: the tenant gate alone would not separate
    // them, so this is the pin the service adds on top of the bound read.
    const fx = await makeFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const jobId = 'job_project_b';
    await openPlan(fx, jobId); // the plan lives in PROD

    const res = await logBugPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx, other.id), body: { jobId, title: 'x' } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_PLAN_FOR_JOB');
    expect(await adminDb.workItem.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
  });

  it('a token from ANOTHER TENANT cannot see the job’s plan at all → 404, and the bound read is what hides it', async () => {
    const a = await makeFixture();
    const b = await makeFixture({ name: 'Beta', identifier: 'BETA' });
    const jobId = 'job_tenant_a';
    const planId = await openPlan(a, jobId);

    const res = await logBugPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(b, b.projectId), body: { jobId, title: 'x' } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_PLAN_FOR_JOB');

    // RLS is the mechanism, not a handler check: under B's bound context A's plan
    // does not exist, while the admin client can see the row is really there.
    const seenByB = await withWorkspaceServiceContext(b.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, b.workspaceId, tx),
    );
    expect(seenByB).toBeNull();
    expect(await adminDb.plan.findUnique({ where: { id: planId } })).not.toBeNull();
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('a `parentKey` from another project is 404 WORK_ITEM_NOT_FOUND — typed apart from a bad token', async () => {
    const fx = await makeFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'Elsewhere' },
      fx.ctx,
    );
    const jobId = 'job_parent_elsewhere';
    await openPlan(fx, jobId);

    const res = await file(fx, jobId, { title: 'x', parentKey: foreign.identifier });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('WORK_ITEM_NOT_FOUND');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('a parent the kind-parent matrix forbids is 422 ILLEGAL_PARENT_TYPE', async () => {
    const fx = await makeFixture();
    const jobId = 'job_parent_illegal';
    await openPlan(fx, jobId);
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'S' },
      fx.ctx,
    );
    const subtask = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'A leaf', parentId: story.id },
      fx.ctx,
    );

    const res = await file(fx, jobId, { title: 'x', parentKey: subtask.identifier });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('ILLEGAL_PARENT_TYPE');
  });

  it('a PRIVATE project the token’s user may not browse is 404, never 403 — no existence leak', async () => {
    const fx = await makeFixture();
    const jobId = 'job_private';
    await openPlan(fx, jobId);
    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'private',
    });
    // A real workspace member who is NOT a member of this private project.
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });

    const res = await logBugPOST(
      req({
        bearer: SERVICE_SECRET,
        token: mintJobToken({
          userId: outsider.id,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
        }),
        body: { jobId, title: 'x' },
      }),
    );
    expect(res.status).toBe(404);
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('a LIMITED project the token’s user may browse but not edit is 403 PROJECT_ACCESS_DENIED', async () => {
    const fx = await makeFixture();
    const jobId = 'job_limited';
    await openPlan(fx, jobId);
    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      level: 'limited',
    });
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });

    const res = await logBugPOST(
      req({
        bearer: SERVICE_SECRET,
        token: mintJobToken({
          userId: outsider.id,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
        }),
        body: { jobId, title: 'x' },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PROJECT_ACCESS_DENIED');
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('a token naming a user who is NOT a member of the workspace is an invariant breach — the route rethrows, and writes nothing', async () => {
    // Core mints a job token only for a member, so this token cannot exist
    // honestly. The bound read admits the OPEN project (RLS keys on the
    // token's workspace claim, not on membership), so the request reaches the
    // membership gate — the one refusal this route does not map, because no
    // caller can earn it.
    const fx = await makeFixture();
    const jobId = 'job_forged';
    await openPlan(fx, jobId);
    const stranger = await createTestUser();

    await expect(
      logBugPOST(
        req({
          bearer: SERVICE_SECRET,
          token: mintJobToken({
            userId: stranger.id,
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
          }),
          body: { jobId, title: 'x' },
        }),
      ),
    ).rejects.toBeInstanceOf(ReporterNotInWorkspaceError);
    expect(await adminDb.workItem.count()).toBe(0);
    expect(await adminDb.planRevision.count({ where: { changeKind: 'bug_filed' } })).toBe(0);
  });

  it('a job with no plan in this tenant → 404 NO_PLAN_FOR_JOB', async () => {
    const fx = await makeFixture();
    const res = await file(fx, 'job_never_opened', { title: 'x' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_PLAN_FOR_JOB');
  });
});

describe('the VOLUME bound — at most PLANNER_BUGS_PER_JOB, counted on the trail', () => {
  it(`files ${PLANNER_BUGS_PER_JOB}, refuses the next as 409 PLANNER_BUG_CAP_EXCEEDED naming cap + count`, async () => {
    const fx = await makeFixture();
    const jobId = 'job_cap';
    const planId = await openPlan(fx, jobId);

    for (let i = 1; i <= PLANNER_BUGS_PER_JOB; i += 1) {
      const res = await file(fx, jobId, { title: `defect ${i}` });
      expect(res.status, `filing ${i}`).toBe(201);
    }
    const over = await file(fx, jobId, { title: 'one too many' });
    expect(over.status).toBe(409);
    const body = await over.json();
    expect(body.code).toBe('PLANNER_BUG_CAP_EXCEEDED');
    expect(body.cap).toBe(PLANNER_BUGS_PER_JOB);
    expect(body.filed).toBe(PLANNER_BUGS_PER_JOB);

    // The refusal wrote NOTHING — neither a card nor a trail row.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(
      PLANNER_BUGS_PER_JOB,
    );
    const filed = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.countByPlanAndKind(planId, PLANNER_BUG_FILED_CHANGE_KIND, tx),
    );
    expect(filed).toBe(PLANNER_BUGS_PER_JOB);
  });

  it('the cap is PER JOB — a second job on the same project has its own', async () => {
    const fx = await makeFixture();
    await openPlan(fx, 'job_cap_a');
    await openPlan(fx, 'job_cap_b');
    for (let i = 1; i <= PLANNER_BUGS_PER_JOB; i += 1) {
      expect((await file(fx, 'job_cap_a', { title: `a ${i}` })).status).toBe(201);
    }
    expect((await file(fx, 'job_cap_a', { title: 'a over' })).status).toBe(409);
    expect((await file(fx, 'job_cap_b', { title: 'b 1' })).status).toBe(201);
  });
});

describe('auth + body shape — the family posture', () => {
  it('rejects a missing service bearer → 401 service_unauthorized', async () => {
    const fx = await makeFixture();
    const res = await logBugPOST(
      req({ token: tokenFor(fx, fx.projectId), body: { jobId: 'j', title: 'x' } }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('service_unauthorized');
  });

  it('rejects a missing job token → 401 token_invalid (the bearer alone is the OTHER route)', async () => {
    const res = await logBugPOST(req({ bearer: SERVICE_SECRET, body: { jobId: 'j', title: 'x' } }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('token_invalid');
  });

  it('400s a body that is not JSON', async () => {
    const fx = await makeFixture();
    const res = await logBugPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx, fx.projectId), raw: '{not json' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('LOG_BUG_INVALID');
  });

  it.each([
    ['no jobId', { title: 'x' }],
    ['blank jobId', { jobId: '  ', title: 'x' }],
    ['no title', { jobId: 'j' }],
    ['blank title', { jobId: 'j', title: '   ' }],
    ['non-string descriptionMd', { jobId: 'j', title: 'x', descriptionMd: 7 }],
    ['non-string parentKey', { jobId: 'j', title: 'x', parentKey: ['PROD-1'] }],
    ['non-string model', { jobId: 'j', title: 'x', model: { name: 'x' } }],
  ])('400s %s', async (_label, body) => {
    const fx = await makeFixture();
    const res = await logBugPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx, fx.projectId), body }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('LOG_BUG_INVALID');
  });
});

describe('THE COMPOSITION (MOTIR-4053) — file, name the key, and the story is held until the bug closes', () => {
  it('a proposed story `blocked_by` the filed bug is not finishable while the bug is open, and is once it is done', async () => {
    const fx = await makeFixture();
    const jobId = 'job_composition';
    const planId = await openPlan(fx, jobId);

    // 1. file → a real key comes back.
    const filedRes = await file(fx, jobId, { title: 'The export drops the last row' });
    expect(filedRes.status).toBe(201);
    const bug = (await filedRes.json()) as { key: string; id: string };

    // 2. name that key in a proposal's `blockedByRefs` — a REAL id, the executor's
    //    third branch, exactly as motir-ai's `propose_node` sends it.
    const plan = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Rebuild the export on the streaming reader', kind: 'story' },
          blockedByRefs: [bug.id],
        },
      ],
      fx.ctx,
    );
    const storyRef = `planItem:${plan.items[0]!.id}`;

    // 3. the SHIPPED projected read — what `validate_plan` reaches through
    //    `POST /api/internal/ai/validate-plan` — holds the story out: the open
    //    bug is an out-of-subtree, unsatisfied blocker.
    const open = await planValidityService.validateProjectedWorkItem(planId, storyRef, fx.ctx);
    expect(open.valid).toBe(false);
    expect(open.blockers.map((b) => b.blockedBy)).toEqual([bug.key]);
    expect(open.blockers[0]!.blockerStatus).toBe('todo');

    // 4. close the bug → the same read now says finishable.
    await workItemsService.updateStatus(bug.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(bug.id, 'done', fx.ctx);
    const closed = await planValidityService.validateProjectedWorkItem(planId, storyRef, fx.ctx);
    expect(closed.valid).toBe(true);
    expect(closed.blockers).toEqual([]);
  });
});
