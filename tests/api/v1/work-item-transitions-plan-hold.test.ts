import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { planTargetHeldSchema } from '@/lib/api/v1/workItems/schema';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/work-items/{key}/transitions — THE PLAN HOLD's refusal (Story
// MOTIR-6017 · Subtask MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21): 422
// `PLAN_TARGET_HELD`, the same status as the gate's refusal, carrying the same
// `plan` payload the board and the status action carry.

type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function post(key: string, caller: V1ProjectCaller, status: string): Promise<Response> {
  const mod = (await import('@/app/api/v1/work-items/[key]/transitions/route')) as unknown as {
    POST: Handler;
  };
  return mod.POST(
    new Request(`http://localhost:3000/api/v1/work-items/${key}/transitions`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ key }) },
  );
}

describe('the transitions door refuses a move out of Planning an undecided plan holds', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('answers 422 `PLAN_TARGET_HELD` with the plan payload, and moves nothing', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Held' },
      caller.ctx,
    );
    const plan = await plansService.createPlan(
      caller.fixture.projectId,
      { title: 'Re-plan' },
      caller.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: item.id, patch: { descriptionMd: 'Re-scoped.' } }],
      caller.ctx,
    );
    await plansService.markPlanned(plan.id, caller.ctx);

    const res = await post(item.identifier, caller, 'in_progress');

    expect(res.status).toBe(422);
    const body = planTargetHeldSchema.parse(await res.json());
    expect(body.plan).toMatchObject({
      itemKey: item.identifier,
      workItemId: item.id,
      planId: plan.id,
      planStatus: 'planned',
    });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'planning',
    );
  });
});
