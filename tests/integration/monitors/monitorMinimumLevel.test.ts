import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';
import { fakeMonitorProvider, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The per-connection MINIMUM LEVEL write and the room's INGESTION STATE (Story
// MOTIR-4929 · Subtask MOTIR-5579) — `setMinimumLevel`, its PATCH route under
// `integration:manage`, and the DTO's poll fields.
//
// Driven through the ROUTE where the criterion is about the route (the status
// codes, the gate, the response shape) and through the service where it is
// about the stored row. The session is the one thing stubbed, exactly as
// `monitorStorySeams.test.ts` stubs it: a route test has no cookie jar.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const workspaceCookie = { current: null as string | null };

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/auth');
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/workspaces', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspaces');
  return {
    ...actual,
    getWorkspaceContext: async () =>
      session.current && workspaceCookie.current
        ? { userId: session.current.user.id, workspaceId: workspaceCookie.current }
        : null,
  };
});

const VIEW = await import('@/app/api/projects/[key]/monitors/route');
const ONE = await import('@/app/api/projects/[key]/monitors/[connectionId]/route');

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  session.current = null;
  workspaceCookie.current = null;
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

function signInAs(user: { id: string; email: string; name: string | null }, workspaceId: string) {
  session.current = { user: { id: user.id, email: user.email, name: user.name ?? 'Someone' } };
  workspaceCookie.current = workspaceId;
}

/** A project with a grant and one binding made through the real service. */
async function seed(): Promise<{ fx: WorkItemFixture; connectionId: string }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Level ${n}`, identifier: `LVL${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-level-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  signInAs(fx.owner, fx.workspaceId);
  return { fx, connectionId: dto.id };
}

function patch(fx: WorkItemFixture, connectionId: string, body: unknown) {
  return ONE.PATCH(
    new Request(
      `https://motir.test/api/projects/${fx.projectIdentifier}/monitors/${connectionId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ key: fx.projectIdentifier, connectionId }) },
  );
}

async function readView(fx: WorkItemFixture): Promise<MonitorConnectionViewDto> {
  const res = await VIEW.GET(
    new Request(`https://motir.test/api/projects/${fx.projectIdentifier}/monitors`),
    { params: Promise.resolve({ key: fx.projectIdentifier }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as MonitorConnectionViewDto;
}

const storedRow = (id: string) => adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });

describe('PATCH /api/projects/[key]/monitors/[connectionId]', () => {
  it('stores a level and returns the DTO carrying it; `null` stores null', async () => {
    const { fx, connectionId } = await seed();

    const res = await patch(fx, connectionId, { minimumLevel: 'error' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as MonitorConnectionDto).minimumLevel).toBe('error');
    expect((await storedRow(connectionId)).minimumLevel).toBe('error');

    const cleared = await patch(fx, connectionId, { minimumLevel: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as MonitorConnectionDto).minimumLevel).toBeNull();
    expect((await storedRow(connectionId)).minimumLevel).toBeNull();
  });

  it('refuses a level the vocabulary does not have with 400 and the typed code', async () => {
    const { fx, connectionId } = await seed();

    const res = await patch(fx, connectionId, { minimumLevel: 'loud' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_MONITOR_LEVEL');
    // A body with no level at all is not "every level" — it is no answer.
    const empty = await patch(fx, connectionId, {});
    expect(empty.status).toBe(400);
    expect((await storedRow(connectionId)).minimumLevel).toBeNull();
  });

  it('answers 404 for a connection that belongs to ANOTHER project', async () => {
    const mine = await seed();
    const theirs = await seed();
    signInAs(mine.fx.owner, mine.fx.workspaceId);

    const res = await patch(mine.fx, theirs.connectionId, { minimumLevel: 'error' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('MONITOR_CONNECTION_NOT_FOUND');
    expect((await storedRow(theirs.connectionId)).minimumLevel).toBeNull();
  });

  it('refuses a member without `integration:manage` with 403 — a real membership, not a stub', async () => {
    const { fx, connectionId } = await seed();
    const viewer = await adminDb.user.create({
      data: { name: 'Viewer', email: `viewer-level-${Date.now()}@example.com` },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: viewer.id, role: 'member' },
    });
    await adminDb.projectMembership.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        userId: viewer.id,
        role: 'viewer',
      },
    });
    signInAs(viewer, fx.workspaceId);

    const res = await patch(fx, connectionId, { minimumLevel: 'error' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { permission?: string }).permission).toBe('integration:manage');
    expect((await storedRow(connectionId)).minimumLevel).toBeNull();
  });

  it('returns the SAME DTO shape the room’s read returns — one contract, two doors', async () => {
    const { fx, connectionId } = await seed();

    const written = (await (
      await patch(fx, connectionId, { minimumLevel: 'warning' })
    ).json()) as MonitorConnectionDto;
    const read = (await readView(fx)).connections.find((c) => c.id === connectionId)!;

    expect(Object.keys(written).sort()).toEqual(Object.keys(read).sort());
    expect(written).toEqual(read);
  });
});

describe('LOWERING rewinds the watermark; RAISING leaves it', () => {
  const at = new Date('2026-09-18T09:00:00.000Z');

  async function withLevel(level: string | null) {
    const s = await seed();
    await adminDb.monitorConnection.update({
      where: { id: s.connectionId },
      data: { minimumLevel: level, lastSeenWatermark: at },
    });
    return s;
  }

  it('error → warning resets the watermark to null', async () => {
    const { fx, connectionId } = await withLevel('error');
    await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, 'warning', fx.ctx);
    expect((await storedRow(connectionId)).lastSeenWatermark).toBeNull();
  });

  it('error → null (every level) resets the watermark to null', async () => {
    const { fx, connectionId } = await withLevel('error');
    await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, null, fx.ctx);
    expect((await storedRow(connectionId)).lastSeenWatermark).toBeNull();
  });

  it('warning → error leaves a set watermark unchanged', async () => {
    const { fx, connectionId } = await withLevel('warning');
    await monitorConnectionService.setMinimumLevel(fx.projectId, connectionId, 'error', fx.ctx);
    const row = await storedRow(connectionId);
    expect(row.minimumLevel).toBe('error');
    expect(row.lastSeenWatermark?.toISOString()).toBe(at.toISOString());
  });
});

describe('the room’s read carries the ingestion state', () => {
  it('returns the poll fields for EVERY connection — null on a never-polled row', async () => {
    const { fx, connectionId } = await seed();
    const second = await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: 'fake-worker', externalProjectSlug: 'worker' },
      fx.ctx,
    );
    const polledAt = new Date('2026-09-18T10:30:00.000Z');
    await adminDb.monitorConnection.update({
      where: { id: connectionId },
      data: {
        minimumLevel: 'error',
        lastPolledAt: polledAt,
        lastPollStatus: 'failed',
        lastPollError: 'more than 20 pages of issues since the last check',
        lastPollFiledCount: null,
        lastPollSucceededAt: new Date('2026-09-18T10:00:00.000Z'),
      },
    });

    const view = await readView(fx);

    const polled = view.connections.find((c) => c.id === connectionId)!;
    expect(polled).toMatchObject({
      minimumLevel: 'error',
      lastPolledAt: polledAt.toISOString(),
      lastPollStatus: 'failed',
      lastPollError: 'more than 20 pages of issues since the last check',
      lastPollFiledCount: null,
      lastPollSucceededAt: '2026-09-18T10:00:00.000Z',
    });
    const never = view.connections.find((c) => c.id === second.id)!;
    expect(never).toMatchObject({
      minimumLevel: null,
      lastPolledAt: null,
      lastPollStatus: null,
      lastPollError: null,
      lastPollFiledCount: null,
      lastPollSucceededAt: null,
    });
    // Still no credential anywhere in the payload.
    expect(JSON.stringify(view)).not.toContain('fake-access-token');
  });
});
