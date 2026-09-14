import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { approvalGatePendingSchema } from '@/lib/api/v1/workItems/schema';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/work-items/{key}/transitions — the APPROVAL-GATE GUARD's refusal
// (Story MOTIR-4887 · Subtask MOTIR-5526): 422 `APPROVAL_GATE_PENDING`, beside the
// sub-resource's four other refusal codes, carrying the same `gate` payload the
// board and the status action carry.

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

describe('the transitions door refuses a move an approval holds', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  async function gatedItem() {
    const story = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'Story' },
      caller.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'subtask', parentId: story.id, title: 'D' },
      caller.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', caller.ctx);
    await withWorkspaceContext(caller.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: caller.fixture.workspaceId,
          projectId: caller.fixture.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: `subject-${item.id}`,
        },
        tx,
      ),
    );
    return item;
  }

  it('answers 422 `APPROVAL_GATE_PENDING` with the gate payload, and moves nothing', async () => {
    const item = await gatedItem();

    const res = await post(item.identifier, caller, 'done');

    expect(res.status).toBe(422);
    const body = approvalGatePendingSchema.parse(await res.json());
    expect(body.gate).toMatchObject({ itemKey: item.identifier, kind: 'design_result' });
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
  });

  it('`→ in_progress` on the same item is still a 200', async () => {
    const item = await gatedItem();
    const res = await post(item.identifier, caller, 'in_progress');
    expect(res.status).toBe(200);
  });
});
