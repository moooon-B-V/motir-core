import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { mintJobToken } from '@/lib/ai/jobToken';
import {
  AI_DECIDED_PLAN_STATUSES,
  AI_PENDING_PLAN_STATUSES,
  AI_PENDING_PLANS_LIMIT,
} from '@/lib/dto/ai';
import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import { GET as pendingPlansGET } from '@/app/api/internal/ai/pending-plans/route';
import {
  createTestProject,
  makeWorkItemFixture as makeFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — `GET /api/internal/ai/pending-plans` (MOTIR-4106), the ai→core
// read that answers WHAT IS ALREADY PROPOSED on the token's project. Driven end
// to end through the REAL route against a real Postgres, in the shape
// `readbackRoutes.test.ts` established for this family.
//
// ⚠️ THE ARM THAT MATTERS IS THE EMPTY ONE. A read that returns the pending
// plans is easy to get right and easy to over-return: an `approved` plan IS the
// tree and a `declined` one is history, so reporting either as in flight tells a
// planner to stand down in front of work that is finished. The positive cases
// below can all pass on a route that simply lists every plan the project holds;
// only the decided-only case can fail on it.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
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
  await adminDb.$disconnect();
});

function pendingPlansReq(opts: { bearer?: string; token?: string; cookie?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  return new Request('http://core/api/internal/ai/pending-plans', { headers });
}

function tokenFor(fx: WorkItemFixture): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

/** A plan in the given status, driven through the real service as far as the
 *  service goes. `stale` has no service path of its own — it is written by the
 *  drift guard inside `approvePlan`'s refusal — so it is set directly, exactly
 *  as `tests/integration/plans/planDrift.test.ts` sets it. */
async function planIn(
  fx: WorkItemFixture,
  status: (typeof PLAN_STATUS_DTO_VALUES)[number],
  title: string,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  if (status === 'generating') return plan.id;
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return plan.id;
  if (status === 'stale') {
    await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'stale' } });
    return plan.id;
  }
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

async function readPending(fx: WorkItemFixture): Promise<{
  status: number;
  body: { plans: Array<Record<string, unknown>>; truncated: boolean };
}> {
  const res = await pendingPlansGET(
    pendingPlansReq({ bearer: SERVICE_SECRET, token: tokenFor(fx) }),
  );
  return { status: res.status, body: await res.json() };
}

describe('GET /api/internal/ai/pending-plans — which plans are PENDING', () => {
  it('returns a `generating` plan and a `planned` plan, newest first', async () => {
    const fx = await makeFixture();
    const generating = await planIn(fx, 'generating', 'still being written');
    const planned = await planIn(fx, 'planned', 'awaiting a reviewer');

    const { status, body } = await readPending(fx);
    expect(status).toBe(200);
    expect(body.plans.map((p) => p['id'])).toEqual([planned, generating]);
    expect(body.truncated).toBe(false);
  });

  // ⚠️ `stale` is PENDING, and this case is the reason the set is three values
  // rather than the obvious two. `PlanStatus`'s own schema comment: "`stale` …
  // is NOT terminal and NOT decided: the plan is live and awaiting action, and
  // its exits are the drift reversing (back to `planned`) or a reviewer
  // declining it." A stale plan is a proposal a reviewer is holding — precisely
  // the work a second proposal would duplicate.
  it('returns a `stale` plan — it is live and awaiting action, not decided', async () => {
    const fx = await makeFixture();
    const stale = await planIn(fx, 'stale', 'drifted under the reviewer');

    const { body } = await readPending(fx);
    expect(body.plans.map((p) => p['id'])).toEqual([stale]);
    expect(body.plans[0]!['status']).toBe('stale');
  });

  // ⚠️ THE ARM THAT MATTERS. Everything above passes on a route that lists every
  // plan; only this one fails on it.
  it('returns an EMPTY list for a project whose only plans are approved / declined', async () => {
    const fx = await makeFixture();
    await planIn(fx, 'approved', 'this one became the tree');
    await planIn(fx, 'declined', 'this one was rejected');

    const { status, body } = await readPending(fx);
    expect(status).toBe(200);
    expect(body.plans).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it('leaves the decided plans out of a project that also holds pending ones', async () => {
    const fx = await makeFixture();
    const pending = await planIn(fx, 'planned', 'awaiting a reviewer');
    await planIn(fx, 'approved', 'already the tree');
    await planIn(fx, 'declined', 'already rejected');

    const { body } = await readPending(fx);
    expect(body.plans.map((p) => p['id'])).toEqual([pending]);
  });

  it('scopes to the TOKEN project — a sibling project in the SAME workspace does not leak', async () => {
    const fx = await makeFixture();
    // A second project the token's own user can browse, in the token's own
    // workspace: the case the access gate cannot catch, because the read is
    // permitted and only the PROJECT is wrong.
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Sibling',
      identifier: 'SIBL',
    });
    const mine = await planIn(fx, 'planned', 'mine');
    await plansService.markPlanned(
      (await plansService.createPlan(sibling.id, { title: 'theirs' }, fx.ctx)).id,
      fx.ctx,
    );

    const { body } = await readPending(fx);
    expect(body.plans.map((p) => p['id'])).toEqual([mine]);
  });
});

describe('GET /api/internal/ai/pending-plans — the BOUND', () => {
  it(`caps the page at ${AI_PENDING_PLANS_LIMIT} and says so with \`truncated\``, async () => {
    const fx = await makeFixture();
    for (let i = 0; i < AI_PENDING_PLANS_LIMIT + 3; i += 1) {
      await planIn(fx, 'planned', `pending ${i}`);
    }

    const { body } = await readPending(fx);
    expect(body.plans).toHaveLength(AI_PENDING_PLANS_LIMIT);
    expect(body.truncated).toBe(true);
    // The cap is a BOUND, not a page: nothing hands the caller a way to ask for
    // the rest, because the answer this seam gives is "there are plans in flight".
    expect(body).not.toHaveProperty('nextCursor');
  });

  it('carries the item COUNT and never the items — and no field beyond the five', async () => {
    const fx = await makeFixture();
    const planned = await plansService.createPlan(fx.projectId, { title: 'sized' }, fx.ctx);
    await plansService.addProposals(
      planned.id,
      [
        { op: 'add', proposedFields: { title: 'first', kind: 'task' } },
        { op: 'add', proposedFields: { title: 'second', kind: 'task' } },
      ],
      fx.ctx,
    );

    const { body } = await readPending(fx);
    const row = body.plans[0]!;
    expect(row['itemCount']).toBe(2);
    // The bound on WHAT each row carries, asserted as an equality rather than as
    // a set of absences — `PlanDto`'s `summary` (free prose a user wrote), its
    // `sourceJobId` and its author/decider ids must not cross the boundary, and
    // neither must the next field somebody adds to `PlanDto`.
    expect(Object.keys(row).sort()).toEqual(
      ['createdAt', 'id', 'itemCount', 'status', 'title'].sort(),
    );
  });
});

describe('GET /api/internal/ai/pending-plans — auth', () => {
  it('401s a missing service bearer', async () => {
    const fx = await makeFixture();
    const res = await pendingPlansGET(pendingPlansReq({ token: tokenFor(fx) }));
    expect(res.status).toBe(401);
  });

  it('401s a missing job token', async () => {
    await makeFixture();
    const res = await pendingPlansGET(pendingPlansReq({ bearer: SERVICE_SECRET }));
    expect(res.status).toBe(401);
  });

  it('401s a tampered token', async () => {
    const fx = await makeFixture();
    const [payload] = tokenFor(fx).split('.');
    const res = await pendingPlansGET(
      pendingPlansReq({ bearer: SERVICE_SECRET, token: `${payload}.deadbeef` }),
    );
    expect(res.status).toBe(401);
  });

  it('401s an expired token', async () => {
    const fx = await makeFixture();
    const expired = mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
      ttlSeconds: -1,
    });
    const res = await pendingPlansGET(pendingPlansReq({ bearer: SERVICE_SECRET, token: expired }));
    expect(res.status).toBe(401);
  });

  // The route is service-to-service ONLY. Neither of the two credentials a
  // human-facing caller holds is one of the two this surface takes: a workspace
  // PAT presented as the `Authorization` bearer is not `CORE_CALLBACK_SECRET`,
  // and a cookie session is never read here at all.
  it('401s a workspace PAT in the Authorization header', async () => {
    const fx = await makeFixture();
    const res = await pendingPlansGET(
      pendingPlansReq({ bearer: 'motir_pat_a_perfectly_real_looking_token', token: tokenFor(fx) }),
    );
    expect(res.status).toBe(401);
  });

  it('401s a cookie session, with or without a job token', async () => {
    const fx = await makeFixture();
    const withToken = await pendingPlansGET(
      pendingPlansReq({ cookie: 'better-auth.session_token=whatever', token: tokenFor(fx) }),
    );
    expect(withToken.status).toBe(401);
    const bare = await pendingPlansGET(
      pendingPlansReq({ cookie: 'better-auth.session_token=whatever' }),
    );
    expect(bare.status).toBe(401);
  });

  it('404s a foreign-project token (404-not-403)', async () => {
    const a = await makeFixture();
    const b = await makeFixture({ name: 'Other', identifier: 'OTHR' });
    await planIn(b, 'planned', "b's own plan");
    // A's user, but a token claiming B's project (which A cannot browse).
    const foreign = mintJobToken({
      userId: a.ctx.userId,
      workspaceId: a.ctx.workspaceId,
      projectId: b.projectId,
    });
    const res = await pendingPlansGET(pendingPlansReq({ bearer: SERVICE_SECRET, token: foreign }));
    expect(res.status).toBe(404);
  });
});

describe('aiBoundaryService.readPendingPlans — the set is the METHOD’s decision', () => {
  // ⚠️ TOTALITY, asserted from BOTH sides. `AI_PENDING_PLAN_STATUSES` is an
  // enumeration, and an enumeration of a growing vocabulary is the shape that
  // fails by being TRUE: every member listed really is pending, and the member
  // nobody listed is silently treated as decided. A sixth `PlanStatus` lands in
  // neither list and turns this red, which is the only moment anyone will be
  // asked whether it is in flight.
  it('partitions PlanStatus exactly — pending ∪ decided is total, and disjoint', () => {
    const pending = new Set<string>(AI_PENDING_PLAN_STATUSES);
    const decided = new Set<string>(AI_DECIDED_PLAN_STATUSES);
    expect([...pending].filter((s) => decided.has(s))).toEqual([]);
    expect([...PLAN_STATUS_DTO_VALUES].sort()).toEqual([...pending, ...decided].sort());
  });

  it('takes no status argument — a caller cannot ask for a decided plan', async () => {
    const fx = await makeFixture();
    await planIn(fx, 'approved', 'the tree');
    const pending = await planIn(fx, 'planned', 'in flight');

    // The service signature is (projectId, ctx) — there is nowhere to pass a
    // status, which is the whole of "one decision, in one place".
    const result = await aiBoundaryService.readPendingPlans(fx.projectId, fx.ctx);
    expect(result.plans.map((p) => p.id)).toEqual([pending]);
  });
});
