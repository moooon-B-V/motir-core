import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { SHARPENED_BLOCK_START } from '@/lib/sharpening/managedBlock';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// Task MOTIR-1101 · Subtask MOTIR-8175 — the transport of
// `PUT /api/internal/ai/plan-sharpening`: the job-token auth, the body guards,
// each refusal's status, and the round trip back through `PlanDto`.

const { PUT } = await import('@/app/api/internal/ai/plan-sharpening/route');

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface CallOpts {
  bearer?: boolean;
  token?: boolean;
  userId?: string;
}

function put(
  fx: WorkItemFixture,
  raw: string,
  { bearer = true, token = true, userId = fx.ctx.userId }: CallOpts = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (bearer) headers.set('authorization', `Bearer ${SERVICE_SECRET}`);
  if (token) {
    headers.set(
      'x-motir-job-token',
      mintJobToken({ userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId }),
    );
  }
  return PUT(
    new Request('http://core/api/internal/ai/plan-sharpening', {
      method: 'PUT',
      headers,
      body: raw,
    }),
  );
}

const REQUIREMENT = { behaviour: '- What happens on export? — A CSV downloads.' };
const PLANNER = [{ question: 'Which date format?', recommendation: 'ISO 8601' }];

async function planWithAdd(fx: WorkItemFixture): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Sharpen', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A card', kind: 'task', difficulty: 'low' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

function planBody(planId: string, itemId: string): string {
  return JSON.stringify({
    jobId: 'job-1',
    scope: { planId },
    requirement: REQUIREMENT,
    plannerAssumptions: PLANNER,
    perItem: [{ planItemId: itemId, acceptance: ['A CSV downloads'], assumptions: ['Paged'] }],
  });
}

describe('PUT /api/internal/ai/plan-sharpening', () => {
  it('401 without the service bearer or without the job token', async () => {
    const fx = await makeWorkItemFixture();
    expect((await put(fx, '{}', { bearer: false })).status).toBe(401);
    expect((await put(fx, '{}', { token: false })).status).toBe(401);
  });

  it.each([
    ['a non-JSON body', '{nope'],
    ['a non-object body', 'null'],
    ['a missing jobId', JSON.stringify({ scope: { planId: 'p' } })],
    ['a scope that is neither shape', JSON.stringify({ jobId: 'j', scope: { other: 'x' } })],
    [
      'a scope naming both',
      JSON.stringify({ jobId: 'j', scope: { planId: 'p', workItemKey: 'A-1' } }),
    ],
    [
      'a wrong-typed requirement part',
      JSON.stringify({ jobId: 'j', scope: { planId: 'p' }, requirement: { behaviour: 1 } }),
    ],
    [
      'a malformed planner assumption',
      JSON.stringify({
        jobId: 'j',
        scope: { planId: 'p' },
        plannerAssumptions: [{ question: 'q' }],
      }),
    ],
  ])('400 for %s', async (_label, raw) => {
    const fx = await makeWorkItemFixture();
    const res = await put(fx, raw);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('SHARPENING_INVALID');
  });

  it('200 on plan scope, round-tripping through PlanDto; idempotent on a resend', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx);

    const res = await put(fx, planBody(planId, itemId));
    expect(res.status).toBe(200);
    const result = (await res.json()) as { scope: unknown; settledAt: string };
    expect(result.scope).toEqual({ planId });

    const plan = await plansService.getPlan(planId, fx.ctx);
    expect(plan.sharpenedRequirement).toEqual({
      ...REQUIREMENT,
      plannerAssumptions: PLANNER,
      settledAt: result.settledAt,
    });
    const body = plan.items.find((i) => i.id === itemId)!.proposedFields!.descriptionMd as string;
    expect(body.split(SHARPENED_BLOCK_START)).toHaveLength(3);

    expect((await put(fx, planBody(planId, itemId))).status).toBe(200);
    const again = await plansService.getPlan(planId, fx.ctx);
    expect(again.items.find((i) => i.id === itemId)!.proposedFields!.descriptionMd).toBe(body);
  });

  it('404 for a plan id that does not exist', async () => {
    const fx = await makeWorkItemFixture();
    const res = await put(
      fx,
      JSON.stringify({ jobId: 'j', scope: { planId: 'missing' }, plannerAssumptions: [] }),
    );
    expect(res.status).toBe(404);
  });

  it('409 SHARPENING_PLAN_CLOSED on a decided plan', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    const res = await put(fx, planBody(planId, itemId));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SHARPENING_PLAN_CLOSED');
  });

  it('422 for a perItem of another plan', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithAdd(fx);
    const other = await planWithAdd(fx);
    const res = await put(fx, planBody(planId, other.itemId));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SHARPENING_INPUT_INVALID');
  });

  describe('work-item scope', () => {
    function itemBody(key: string): string {
      return JSON.stringify({
        jobId: 'job-1',
        scope: { workItemKey: key },
        requirement: REQUIREMENT,
        plannerAssumptions: PLANNER,
      });
    }

    it('200 and the blocks land; 409 SHARPENING_TARGET_FINISHED once done', async () => {
      const fx = await makeWorkItemFixture();
      const row = await createTestWorkItem(fx, { kind: 'task', title: 'Export' });

      const res = await put(fx, itemBody(row.identifier));
      expect(res.status).toBe(200);
      expect((await res.json()).scope).toEqual({ workItemKey: row.identifier });
      const body = (await adminDb.workItem.findUniqueOrThrow({ where: { id: row.id } }))
        .descriptionMd!;
      expect(body).toContain("- Planner's assumption — Which date format? — ISO 8601");

      await adminDb.workItem.update({ where: { id: row.id }, data: { status: 'done' } });
      const done = await put(fx, itemBody(row.identifier));
      expect(done.status).toBe(409);
      expect((await done.json()).code).toBe('SHARPENING_TARGET_FINISHED');
    });

    it('403 for a token user who can browse but not edit; nothing is written', async () => {
      const fx = await makeWorkItemFixture();
      const row = await createTestWorkItem(fx, { kind: 'task', title: 'Export' });
      const viewer = await createTestUser();
      await adminDb.workspaceMembership.create({
        data: { userId: viewer.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
      });
      await addToProjectAs({
        key: fx.projectIdentifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        targetUserId: viewer.id,
        role: 'viewer',
      });

      const res = await put(fx, itemBody(row.identifier), { userId: viewer.id });
      expect(res.status).toBe(403);
      expect(
        (await adminDb.workItem.findUniqueOrThrow({ where: { id: row.id } })).descriptionMd,
      ).toBe(row.descriptionMd);
    });

    it('404 for a key that names no item', async () => {
      const fx = await makeWorkItemFixture();
      const res = await put(fx, itemBody(`${fx.projectIdentifier}-999`));
      expect(res.status).toBe(404);
    });
  });
});
