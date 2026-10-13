import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { NATIVE_PLANNER_HARNESS } from '@/lib/ai/plannerTenantBug';
import { PLAN_REVISION_LEASE_MS } from '@/lib/planChange/revisionLease';
import { POST as leasePOST } from '@/app/api/internal/ai/plan-revision-lease/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Bug MOTIR-8523) — the hosted revision's HEARTBEAT,
// `POST /api/internal/ai/plan-revision-lease`, end to end through the REAL route
// against a real Postgres.
//
// The bug: core takes the revision lease at a hosted submit, and nothing renewed
// it, so a revision whose conversation and author sessions ran past the
// ten-minute window without writing the plan's trail lapsed under a LIVE job —
// the plan went back to `planned` and the job's final append was refused. These
// cases pin the two halves of the card's acceptance:
//   · a job that keeps renewing keeps its lease past the window;
//   · a job that stops renewing (it died) still lapses and restores `planned`.
// and the door's own edges: it renews only the JOB's lease, never takes one, and
// answers a foreign job the family's 404.
//
// Time is moved by AGEING the stored trail (the `revisionLease.test.ts` idiom),
// because the lease is read off `changedAt`, not off a clock the test could fake.

const SERVICE_SECRET = 'core-callback-secret-test';
const AGENT = { source: null, harness: 'Claude Code', model: 'claude-opus-5' };

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

function tokenFor(fx: Fx, projectId = fx.projectId): string {
  return mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId });
}

function req(opts: { bearer?: string; token?: string; body?: unknown; raw?: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/plan-revision-lease', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

/** A `planned` plan — the state a hosted revision is submitted against. */
async function plannedPlan(fx: Fx): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The surface', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** What a hosted submit does: take the lease FOR the job (which binds `sourceJobId`). */
async function revisingJob(fx: Fx, jobId: string): Promise<string> {
  const planId = await plannedPlan(fx);
  await plansService.acquireRevisionLease(
    planId,
    fx.ctx,
    { source: 'native', harness: NATIVE_PLANNER_HARNESS, model: null },
    { jobId },
  );
  return planId;
}

/** Move every trail row `ms` into the past — the window is read off `changedAt`. */
async function ageTrail(planId: string, ms: number): Promise<void> {
  for (const row of await adminDb.planRevision.findMany({ where: { planId } })) {
    await adminDb.planRevision.update({
      where: { id: row.id },
      data: { changedAt: new Date(row.changedAt.getTime() - ms) },
    });
  }
}

function renew(fx: Fx, body: Record<string, unknown>) {
  return leasePOST(req({ bearer: SERVICE_SECRET, token: tokenFor(fx), body }));
}

const renewals = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: 'revision_renewed' },
    orderBy: { changedAt: 'asc' },
  });

const statusOf = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;

describe('POST /api/internal/ai/plan-revision-lease — the job keeps its lease', () => {
  it('renews the job’s lease: one `revision_renewed` row, attributed to the native planner', async () => {
    const fx = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_renew');

    const res = await renew(fx, { jobId: 'job_lease_renew', planId, model: 'deepseek-v4-pro' });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { planId: string; renewed: boolean; expiresAt: string };
    expect(json.planId).toBe(planId);
    expect(json.renewed).toBe(true);
    expect(new Date(json.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const rows = await renewals(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorSource).toBe('native');
    expect(rows[0]!.actorHarness).toBe(NATIVE_PLANNER_HARNESS);
    expect(rows[0]!.actorModel).toBe('deepseek-v4-pro');
  });

  it('a job that keeps renewing holds the plan PAST the window, and nothing lapses it', async () => {
    const fx = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_long');

    // Two heartbeats, each nine minutes after the last trail row: the session runs
    // eighteen minutes without writing the plan, longer than the ten-minute window.
    for (let beat = 0; beat < 2; beat += 1) {
      await ageTrail(planId, PLAN_REVISION_LEASE_MS - 60_000);
      const res = await renew(fx, { jobId: 'job_lease_long' });
      expect(((await res.json()) as { renewed: boolean }).renewed).toBe(true);
    }

    // The sweep that recovers a dead revision finds nothing to recover.
    const pass = await planSessionEndService.releaseLapsedRevisions();
    expect(pass.planIds).not.toContain(planId);
    expect(await statusOf(planId)).toBe('generating');
    expect(await plansService.readRevisionLease(planId, fx.ctx)).not.toBeNull();
  });

  it('a job that STOPS renewing (it died) still lapses and gives the plan back `planned`', async () => {
    const fx = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_dead');
    await ageTrail(planId, PLAN_REVISION_LEASE_MS + 1000);

    const pass = await planSessionEndService.releaseLapsedRevisions();
    expect(pass.planIds).toEqual([planId]);
    expect(await statusOf(planId)).toBe('planned');
  });
});

describe('POST /api/internal/ai/plan-revision-lease — it never takes a lease', () => {
  it('a LAPSED lease answers `renewed: false`, writes nothing, and still lapses', async () => {
    const fx = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_late');
    await ageTrail(planId, PLAN_REVISION_LEASE_MS + 1000);

    const res = await renew(fx, { jobId: 'job_lease_late' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planId, renewed: false, expiresAt: null });
    expect(await renewals(planId)).toHaveLength(0);
    await planSessionEndService.releaseLapsedRevisions();
    expect(await statusOf(planId)).toBe('planned');
  });

  it('a RELEASED lease answers `renewed: false` and writes nothing', async () => {
    const fx = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_done');
    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);

    const res = await renew(fx, { jobId: 'job_lease_done' });

    expect(await res.json()).toEqual({ planId, renewed: false, expiresAt: null });
    expect(await renewals(planId)).toHaveLength(0);
  });

  it('a lease somebody ELSE holds (a later MCP hold) is not renewed for the old job', async () => {
    const fx = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_old');
    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);
    // A person's agent holds it now over MCP — a start row carrying no `jobId`.
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const res = await renew(fx, { jobId: 'job_lease_old' });

    expect(await res.json()).toEqual({ planId, renewed: false, expiresAt: null });
    expect(await renewals(planId)).toHaveLength(0);
  });
});

describe('POST /api/internal/ai/plan-revision-lease — auth and refusals', () => {
  it('401s without the service bearer, and without a job token', async () => {
    const fx = await makeFixture();
    await revisingJob(fx, 'job_lease_auth');

    const noBearer = await leasePOST(
      req({ token: tokenFor(fx), body: { jobId: 'job_lease_auth' } }),
    );
    expect(noBearer.status).toBe(401);
    const noToken = await leasePOST(
      req({ bearer: SERVICE_SECRET, body: { jobId: 'job_lease_auth' } }),
    );
    expect(noToken.status).toBe(401);
  });

  it('400s a body without a `jobId`, and one that is not JSON', async () => {
    const fx = await makeFixture();

    const missing = await renew(fx, {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('PLAN_REVISION_LEASE_INVALID');
    const garbled = await leasePOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx), raw: '{not json' }),
    );
    expect(garbled.status).toBe(400);
  });

  it('404s a job with no plan, and a `planId` that is not the job’s', async () => {
    const fx = await makeFixture();
    await revisingJob(fx, 'job_lease_mine');
    const other = await plannedPlan(fx);

    const unknown = await renew(fx, { jobId: 'job_nobody_ran' });
    expect(unknown.status).toBe(404);
    const crossed = await renew(fx, { jobId: 'job_lease_mine', planId: other });
    expect(crossed.status).toBe(404);
  });

  it('404s another tenant’s job — the family’s no-existence-leak posture', async () => {
    const fx = await makeFixture();
    const stranger = await makeFixture();
    const planId = await revisingJob(fx, 'job_lease_theirs');

    const res = await renew(stranger, { jobId: 'job_lease_theirs' });

    expect(res.status).toBe(404);
    expect(await renewals(planId)).toHaveLength(0);
  });
});
