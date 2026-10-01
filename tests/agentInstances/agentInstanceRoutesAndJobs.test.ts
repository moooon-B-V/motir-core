import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { agentInstanceIdleCheck } from '@/lib/jobs/definitions/agentInstanceIdleCheck';
import {
  AGENT_INSTANCE_SWEEP_CRON,
  agentInstanceSweep,
} from '@/lib/jobs/definitions/agentInstanceSweep';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { agentInstanceSweepService } from '@/lib/services/agentInstanceSweepService';
import { adminDb } from '../helpers/adminDb';
import { fx, otherMember, setUpHarness, tearDownHarness } from './_harness';

// The agent-instance ROUTES and JOBS (Story MOTIR-6860 · MOTIR-6872, MOTIR-6873;
// the story gate MOTIR-6876). The routes are driven as HTTP over the real
// services and database; only the context resolvers the vitest env cannot provide
// are stubbed — `getSession` and `getWorkspaceContext` — the ready-routes
// precedent. The jobs are driven through the engine registry's own handlers.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const collection = await import('@/app/api/projects/[key]/instances/route');
const one = await import('@/app/api/projects/[key]/instances/[id]/route');
const wake = await import('@/app/api/projects/[key]/instances/[id]/wake/route');
const hibernate = await import('@/app/api/projects/[key]/instances/[id]/hibernate/route');
const update = await import('@/app/api/projects/[key]/instances/[id]/update/route');

beforeEach(async () => {
  await setUpHarness();
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const keyParams = () => ({ params: Promise.resolve({ key: fx.projectIdentifier }) });
const idParams = (id: string) => ({ params: Promise.resolve({ key: fx.projectIdentifier, id }) });
const base = () => `http://test/api/projects/${fx.projectIdentifier}/instances`;
const post = (url: string, body?: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('the routes', () => {
  it('create → list → hibernate → wake → delete, as HTTP', async () => {
    const created = await collection.POST(
      post(base(), { name: 'yue-claude', profileId: 'claude' }),
      keyParams(),
    );
    expect(created.status).toBe(201);
    const { instance } = (await created.json()) as { instance: { id: string; state: string } };
    expect(instance.state).toBe('running');

    const listed = await collection.GET(new Request(`${base()}?page=1&limit=10`), keyParams());
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 1, page: 1, pageSize: 10 });

    const slept = await hibernate.POST(
      post(`${base()}/${instance.id}/hibernate`),
      idParams(instance.id),
    );
    expect(slept.status).toBe(200);
    const woke = await wake.POST(post(`${base()}/${instance.id}/wake`), idParams(instance.id));
    expect(woke.status).toBe(200);
    expect(((await woke.json()) as { instance: { state: string } }).instance.state).toBe('running');
    const gone = await one.DELETE(
      new Request(`${base()}/${instance.id}`, { method: 'DELETE' }),
      idParams(instance.id),
    );
    expect(gone.status).toBe(204);
  });

  it('clamps the page size and defaults a bad page, and refuses a malformed create body', async () => {
    const res = await collection.GET(new Request(`${base()}?page=-3&limit=100000`), keyParams());
    expect(await res.json()).toMatchObject({ page: 1, pageSize: 100 });
    const bad = await collection.POST(post(base(), { name: 7 }), keyParams());
    expect(bad.status).toBe(400);
    const notJson = await collection.POST(
      new Request(base(), { method: 'POST', body: 'not json' }),
      keyParams(),
    );
    expect(notJson.status).toBe(400);
  });

  it('maps typed refusals to statuses — and another member’s agent is a 404 on every door', async () => {
    const created = await collection.POST(
      post(base(), { name: 'mine', profileId: 'claude' }),
      keyParams(),
    );
    const { instance } = (await created.json()) as { instance: { id: string } };
    const taken = await collection.POST(
      post(base(), { name: 'mine', profileId: 'claude' }),
      keyParams(),
    );
    expect(taken.status).toBe(409);

    const other = await otherMember();
    ctxRef.current = other as WorkspaceContext;
    session.user = { id: other.userId, email: 'other@example.com' };
    for (const res of [
      await wake.POST(post(`${base()}/${instance.id}/wake`), idParams(instance.id)),
      await hibernate.POST(post(`${base()}/${instance.id}/hibernate`), idParams(instance.id)),
      await one.DELETE(
        new Request(`${base()}/${instance.id}`, { method: 'DELETE' }),
        idParams(instance.id),
      ),
    ]) {
      expect(res.status).toBe(404);
    }
    const missingProject = await collection.GET(new Request(base()), {
      params: Promise.resolve({ key: 'NOPE' }),
    });
    expect(missingProject.status).toBe(404);
  });

  it('refuses an unauthenticated caller before any service runs', async () => {
    session.user = null;
    ctxRef.current = null;
    const res = await collection.GET(new Request(base()), keyParams());
    expect(res.status).toBe(401);
    for (const res2 of [
      await collection.POST(post(base(), { name: 'x', profileId: 'claude' }), keyParams()),
      await wake.POST(post(`${base()}/x/wake`), idParams('x')),
      await hibernate.POST(post(`${base()}/x/hibernate`), idParams('x')),
      await update.POST(post(`${base()}/x/update`), idParams('x')),
      await one.DELETE(new Request(`${base()}/x`, { method: 'DELETE' }), idParams('x')),
    ]) {
      expect(res2.status).toBe(401);
    }
  });

  it('an unexpected error is rethrown, never mapped to a status', async () => {
    const svc = await import('@/lib/services/agentInstanceLifecycleService');
    for (const [method, call] of [
      ['list', () => collection.GET(new Request(base()), keyParams())],
      [
        'create',
        () => collection.POST(post(base(), { name: 'x', profileId: 'claude' }), keyParams()),
      ],
      ['wake', () => wake.POST(post(`${base()}/x/wake`), idParams('x'))],
      ['hibernate', () => hibernate.POST(post(`${base()}/x/hibernate`), idParams('x'))],
      ['update', () => update.POST(post(`${base()}/x/update`), idParams('x'))],
      ['delete', () => one.DELETE(new Request(`${base()}/x`, { method: 'DELETE' }), idParams('x'))],
    ] as const) {
      const spy = vi
        .spyOn(svc.agentInstanceLifecycleService, method)
        .mockRejectedValueOnce(new Error('kaboom'));
      await expect(call()).rejects.toThrow('kaboom');
      spy.mockRestore();
    }
  });
});

describe('the jobs', () => {
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };

  it('the idle timer is debounced per instance, 30 minutes, capped at 12 hours, and calls checkIdle', async () => {
    expect(agentInstanceIdleCheck.id).toBe('agent-instance/idle-check');
    const spy = vi.spyOn(agentInstanceSweepService, 'checkIdle').mockResolvedValue('active');
    const handler = engineJob('agent-instance/idle-check')!.handler;
    const result = await handler(
      { step, event: { data: { workspaceId: 'w', instanceId: 'i-1' } } } as never,
      jobServices as never,
    );
    expect(result).toBe('active');
    expect(spy).toHaveBeenCalledWith('i-1');
    expect(engineJob('agent-instance/idle-check')!.debounce).toEqual({
      key: 'event.data.instanceId',
      period: '30m',
      timeout: '12h',
    });
  });

  it('the sweep runs every 5 minutes, catches up once, and returns the summary', async () => {
    expect(agentInstanceSweep.id).toBe('system.agent-instance-sweep');
    expect(AGENT_INSTANCE_SWEEP_CRON).toBe('*/5 * * * *');
    expect(agentInstanceSweep.catchUp).toBe('latest');
    const summary = { settled: 0 } as never;
    const spy = vi.spyOn(agentInstanceSweepService, 'sweep').mockResolvedValue(summary);
    const handler = engineJob('system.agent-instance-sweep')!.handler;
    expect(await handler({ step } as never, jobServices as never)).toBe(summary);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
