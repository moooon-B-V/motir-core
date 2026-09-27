import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { dispatchRunOpenedSchema } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/dispatch-runs/{id}/heartbeat (Story MOTIR-6526 · MOTIR-6528) —
// a local run says it is alive. The statuses a CLI must be able to tell apart:
// 204 (recorded), 409 (the run was closed — stop beating), 404 (not yours to
// beat for, in any sense).

const BASE = 'http://localhost:3000/api/v1';

async function heartbeat(caller: V1ProjectCaller, id: string): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/heartbeat/route');
  return POST(
    new Request(`${BASE}/dispatch-runs/${id}/heartbeat`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function seedRun(caller: V1ProjectCaller): Promise<{ id: string; key: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title: 'a card the run owns' },
    caller.fixture.ctx,
  );
  const { POST } = await import('@/app/api/v1/dispatch-runs/route');
  const res = await POST(
    new Request(`${BASE}/dispatch-runs`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectKey: caller.projectKey,
        command: 'run',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      }),
    }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(201);
  const opened = dispatchRunOpenedSchema.parse(await res.json());
  // A new run has never beaten: the field is on the wire, and null.
  expect(opened.run.lastHeartbeatAt).toBeNull();
  return { id: opened.run.id, key: item.identifier };
}

describe('POST /api/v1/dispatch-runs/{id}/heartbeat', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('204 — sets `lastHeartbeatAt` on a running run, and moves no card', async () => {
    const { id, key } = await seedRun(caller);
    const before = await adminDb.workItem.findFirst({
      where: { identifier: key },
      select: { status: true, updatedAt: true },
    });
    const t0 = Date.now();

    const res = await heartbeat(caller, id);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const row = await adminDb.dispatchRun.findUnique({ where: { id } });
    expect(row!.lastHeartbeatAt).not.toBeNull();
    expect(row!.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(row!.status).toBe('running');
    // It writes no event either — the stream is for what the run DID.
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: id } })).toBe(0);
    expect(
      await adminDb.workItem.findFirst({
        where: { identifier: key },
        select: { status: true, updatedAt: true },
      }),
    ).toEqual(before);

    const read = await dispatchRunService.getRun(id, caller.fixture.ctx);
    expect(read.lastHeartbeatAt).toBe(row!.lastHeartbeatAt!.toISOString());
  });

  it('409 — DISPATCH_RUN_TERMINAL on a closed run', async () => {
    const { id } = await seedRun(caller);
    await dispatchRunService.close(id, { stopReason: 'completed' }, caller.fixture.ctx);
    const res = await heartbeat(caller, id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_TERMINAL' });
  });

  it('404 — an unknown run', async () => {
    const res = await heartbeat(caller, 'run_does_not_exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_NOT_FOUND' });
  });

  it('404 — a run in ANOTHER workspace, never a 403', async () => {
    const { id } = await seedRun(caller);
    const other = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'Other',
      identifier: 'OTHR',
    });
    const res = await heartbeat(other, id);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_NOT_FOUND' });
    expect((await adminDb.dispatchRun.findUnique({ where: { id } }))!.lastHeartbeatAt).toBeNull();
  });

  it('declares `work_item:edit`, like its three siblings', () => {
    expect(findV1Operation('POST', '/api/v1/dispatch-runs/{id}/heartbeat')?.permission).toBe(
      'work_item:edit',
    );
  });
});
