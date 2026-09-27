import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { workItemContinueClaimSchema } from '@/lib/api/v1/workLoop/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/work-items/{key}/continue (Story MOTIR-6526 · MOTIR-6532) — what
// only the ROUTE can be wrong about: the body parses against the declared schema,
// a refusal is a 200, a foreign key is a 404, and the permission matches the
// operation. The claim's behaviour is `tests/ready/claimWorkItemContinue.test.ts`.

const BASE = 'http://localhost:3000/api/v1';

async function post(caller: V1ProjectCaller, key: string): Promise<Response> {
  const { POST } = await import('@/app/api/v1/work-items/[key]/continue/route');
  return POST(
    new Request(`${BASE}/work-items/${key}/continue`, { method: 'POST', headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
}

describe('POST /api/v1/work-items/{key}/continue', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('a refusal is a 200 whose body parses against the declared schema', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'never run' },
      caller.fixture.ctx,
    );
    const res = await post(caller, item.identifier);
    expect(res.status).toBe(200);
    const body = workItemContinueClaimSchema.parse(await res.json());
    expect(body).toMatchObject({ outcome: 'not_continuable', reason: 'not_in_progress' });
  });

  it('404 for a key in ANOTHER workspace', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'mine' },
      caller.fixture.ctx,
    );
    const other = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'Other',
      identifier: 'OTHR',
    });
    expect((await post(other, item.identifier)).status).toBe(404);
  });

  it('declares `work_item:edit`', () => {
    expect(findV1Operation('POST', '/api/v1/work-items/{key}/continue')?.permission).toBe(
      'work_item:edit',
    );
  });
});
