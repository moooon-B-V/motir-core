import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary this
// test cannot and must not reach. Everything below it is real: a real Postgres,
// the real `plansService` transactions, the real routes, real job-token auth.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { POST as proposalsPOST } from '@/app/api/internal/ai/plan-proposals/route';
import {
  PATCH as itemPATCH,
  DELETE as itemDELETE,
} from '@/app/api/internal/ai/plan-proposals/[itemId]/route';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3595 · Subtask MOTIR-3598 — the JOB-TOKEN door onto
// `plansService.correctProposal` / `.withdrawProposal`, through the REAL routes.
//
// The service-level half lives in `tests/integration/plans/revisionLease.test.ts`;
// what is here is what only the transport can be wrong about: the explicit
// `mode` discriminator, the DELETE verb, and — the card's own criterion — that
// the service's frozen-status refusal arrives as a TYPED client-visible status
// rather than as a 500.

const SERVICE_SECRET = 'core-callback-secret-test';
const AGENT = { source: null, harness: 'Motir AI', model: 'claude-opus-5' };

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(fx: WorkItemFixture): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function patch(fx: WorkItemFixture, itemId: string, body: unknown): Promise<Response> {
  const req = new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return itemPATCH(req, { params: Promise.resolve({ itemId }) });
}

function del(fx: WorkItemFixture, itemId: string, jobId: string): Promise<Response> {
  const req = new Request(
    `http://core/api/internal/ai/plan-proposals/${itemId}?jobId=${encodeURIComponent(jobId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${SERVICE_SECRET}` } },
  );
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return itemDELETE(req, { params: Promise.resolve({ itemId }) });
}

function append(fx: WorkItemFixture, body: unknown): Promise<Response> {
  const req = new Request('http://core/api/internal/ai/plan-proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_SECRET}` },
    body: JSON.stringify(body),
  });
  req.headers.set('x-motir-job-token', tokenFor(fx));
  return proposalsPOST(req);
}

/** A `planned` plan bound to `jobId`, carrying two `add`s appended separately so
 *  both ids are refable. */
async function plannedPlan(fx: WorkItemFixture, jobId: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const first = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
    fx.ctx,
  );
  const second = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: jobId } });
  return { planId: plan.id, firstId: first.items[0]!.id, secondId: second.items[1]!.id };
}

describe('PATCH — `mode: "correct"` reaches the correction door', () => {
  it('carries the STRUCTURAL fields the deepen turn may not touch', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedPlan(fx, 'job-1');

    const res = await patch(fx, secondId, {
      jobId: 'job-1',
      mode: 'correct',
      parentRef: `planItem:${firstId}`,
      blockedByRefs: [`planItem:${firstId}`],
      patch: { title: 'The dependent, renamed' },
    });
    expect(res.status).toBe(200);

    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(stored.parentRef).toBe(`planItem:${firstId}`);
    expect(stored.blockedByRefs).toEqual([`planItem:${firstId}`]);
    // The CONTENT bag still rides `patch`, exactly as it does on the deepen path
    // — one key, one meaning, on both modes.
    expect((stored.proposedFields as { title?: string }).title).toBe('The dependent, renamed');
    expect(await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
      status: 'planned',
    });
  });

  it('WITHOUT the mode it is the DEEPEN route, byte-identical — and a `planned` plan is refused', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId } = await plannedPlan(fx, 'job-2');

    // The deepen gate is `generating`, and this plan is not. The mode is
    // EXPLICIT precisely so a body that happens to carry `parentRef` cannot
    // silently become a correction and slip past it.
    const res = await patch(fx, firstId, {
      jobId: 'job-2',
      parentRef: 'something',
      patch: { descriptionMd: 'Deepened' },
    });
    expect(res.status).toBe(409);
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: firstId } });
    expect(stored.parentRef).toBeNull();
  });

  it('a `modify`’s patch rides `modifyPatch`, which is a DIFFERENT thing from the content bag', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'With a modify', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const target = await createTestWorkItem(fx, { kind: 'story', title: 'A committed story' });
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: 'job-modify' } });
    const modifyId = appended.items[0]!.id;

    const res = await patch(fx, modifyId, {
      jobId: 'job-modify',
      mode: 'correct',
      modifyPatch: { priority: 'highest' },
    });
    expect(res.status).toBe(200);
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } })).patch,
    ).toMatchObject({ priority: 'highest' });
  });

  it('a FROZEN plan is refused with a TYPED 409, never a 500', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId } = await plannedPlan(fx, 'job-3');
    await plansService.declinePlan(planId, fx.ctx);

    const res = await patch(fx, firstId, {
      jobId: 'job-3',
      mode: 'correct',
      patch: null,
      title: 'Too late',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_EDITABLE' });
  });

  it('an UNRESOLVABLE corrected ref is a typed 422', async () => {
    const fx = await makeWorkItemFixture();
    const { secondId } = await plannedPlan(fx, 'job-4');

    const res = await patch(fx, secondId, {
      jobId: 'job-4',
      mode: 'correct',
      blockedByRefs: ['planItem:nothing-at-all'],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNRESOLVED_PLAN_REF' });
  });
});

describe('DELETE — the withdraw verb', () => {
  it('takes a proposal off the plan and reports what remains', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await plannedPlan(fx, 'job-5');

    const res = await del(fx, secondId, 'job-5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planId, itemCount: 1 });
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('REFUSES a withdraw a sibling still references, naming the referrers', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId, secondId } = await plannedPlan(fx, 'job-6');
    // Wire the dependent at the prerequisite, then try to remove the prerequisite.
    expect(
      (
        await patch(fx, secondId, {
          jobId: 'job-6',
          mode: 'correct',
          blockedByRefs: [`planItem:${firstId}`],
        })
      ).status,
    ).toBe(200);

    const res = await del(fx, firstId, 'job-6');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('PLAN_PROPOSAL_REFERENCED');
    expect(body.error).toContain(secondId);
  });

  it('requires a `jobId`, and cannot reach another job’s plan', async () => {
    const fx = await makeWorkItemFixture();
    const { firstId } = await plannedPlan(fx, 'job-7');

    const req = new Request(`http://core/api/internal/ai/plan-proposals/${firstId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SERVICE_SECRET}` },
    });
    req.headers.set('x-motir-job-token', tokenFor(fx));
    expect((await itemDELETE(req, { params: Promise.resolve({ itemId: firstId }) })).status).toBe(
      400,
    );

    expect((await del(fx, firstId, 'job-nobody')).status).toBe(404);
  });
});

describe('POST — the REVISION pass', () => {
  it('APPENDS to a `planned` plan when it declares itself a revision, and `final` RELEASES', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx, 'job-8');
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const res = await append(fx, {
      jobId: 'job-8',
      revision: true,
      actor: { harness: 'Motir AI', model: 'claude-opus-5' },
      proposals: [{ op: 'add', proposedFields: { title: 'The split half', kind: 'task' } }],
      final: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ planId, planned: false, released: true });

    // The plan is still `planned` — a revision does not open one and does not
    // close one — and it is decidable again.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(3);
    const rows = await adminDb.planRevision.findMany({
      where: { planId },
      orderBy: { changedAt: 'asc' },
    });
    expect(rows.at(-1)).toMatchObject({ changeKind: 'revision_ended', actorHarness: 'Motir AI' });
  });

  it('WITHOUT the flag a `planned` plan still refuses the append', async () => {
    const fx = await makeWorkItemFixture();
    await plannedPlan(fx, 'job-9');
    const res = await append(fx, {
      jobId: 'job-9',
      proposals: [{ op: 'add', proposedFields: { title: 'Sneaked in', kind: 'task' } }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_GENERATING' });
  });
});
