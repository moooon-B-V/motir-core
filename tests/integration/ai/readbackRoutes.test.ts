import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET as planTreeGET } from '@/app/api/internal/ai/plan-tree/route';
import { POST as planDeltaPOST } from '@/app/api/internal/ai/plan-delta/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — the open side's read-back surface end-to-end through the REAL
// routes (Subtask 7.1.8), against a real Postgres. Exercises BOTH auth grants
// (§4a service bearer + §4b job token), the 404-not-403 cross-tenant posture,
// the persist-through-workItemsService authority, and the empty-delta no-op.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

function planTreeReq(opts: { bearer?: string; token?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/plan-tree', { headers });
}

function planDeltaReq(opts: { bearer?: string; token?: string; body: unknown }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/plan-delta', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
}

function tokenFor(fx: { ctx: { userId: string; workspaceId: string }; projectId: string }): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

describe('GET /api/internal/ai/plan-tree — read-back auth', () => {
  it('returns the skeleton for the token project with both credentials', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Auth' },
      fx.ctx,
    );

    const res = await planTreeGET(planTreeReq({ bearer: SERVICE_SECRET, token: tokenFor(fx) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { key: string }) => i.key)).toContain(epic.identifier);
  });

  it('401s a missing service bearer', async () => {
    const fx = await makeFixture();
    const res = await planTreeGET(planTreeReq({ token: tokenFor(fx) }));
    expect(res.status).toBe(401);
  });

  it('401s a tampered token', async () => {
    const fx = await makeFixture();
    const [payload] = tokenFor(fx).split('.');
    const res = await planTreeGET(
      planTreeReq({ bearer: SERVICE_SECRET, token: `${payload}.deadbeef` }),
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
    const res = await planTreeGET(planTreeReq({ bearer: SERVICE_SECRET, token: expired }));
    expect(res.status).toBe(401);
  });

  it('404s a foreign-project token (404-not-403)', async () => {
    const a = await makeFixture();
    const b = await makeFixture(); // different workspace + project
    // A's user, but a token claiming B's project (which A cannot browse).
    const foreign = mintJobToken({
      userId: a.ctx.userId,
      workspaceId: a.ctx.workspaceId,
      projectId: b.projectId,
    });
    const res = await planTreeGET(planTreeReq({ bearer: SERVICE_SECRET, token: foreign }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/internal/ai/plan-delta — persist authority', () => {
  it('an empty delta is a no-op (200, applied:[], nothing created)', async () => {
    const fx = await makeFixture();
    const res = await planDeltaPOST(
      planDeltaReq({ bearer: SERVICE_SECRET, token: tokenFor(fx), body: { operations: [] } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toEqual([]);
    const count = await db.workItem.count({ where: { projectId: fx.projectId } });
    expect(count).toBe(0);
  });

  it('commits a create through workItemsService (verified via repository read)', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );

    const res = await planDeltaPOST(
      planDeltaReq({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          operations: [
            { op: 'create', parentKey: epic.identifier, kind: 'story', fields: { title: 'Story' } },
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    const key = (await res.json()).applied[0].key;
    // the allowed cross-layer test reach: assert the row exists via the repo
    const row = await workItemRepository.findByIdentifier(fx.projectId, key);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Story');
  });

  it('401s a missing service bearer', async () => {
    const fx = await makeFixture();
    const res = await planDeltaPOST(
      planDeltaReq({ token: tokenFor(fx), body: { operations: [] } }),
    );
    expect(res.status).toBe(401);
  });
});
