import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';
import { fakeMonitorProvider, resetFakeMonitorProvider } from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The DIRECTION SWITCHES write and the room's SYNC STATE (Story MOTIR-4931 ·
// Subtask MOTIR-5706) — `setSyncDirections` under `integration:manage`, the
// connection PATCH accepting both switches beside `minimumLevel`, and the view
// DTO carrying the switches and the last sync failure. The same harness as the
// minimum-level suite it mirrors (MOTIR-5579).
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
  const fx = await makeWorkItemFixture({ name: `Sync ${n}`, identifier: `SYN${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-sync-${n}`,
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

/** A member whose CUSTOM role holds exactly `permissions` — permission, never
 *  role: a built-in role pairs keys, so only a custom one isolates the gate. */
async function customMember(fx: WorkItemFixture, permissions: string[]) {
  const user = await createTestUser({
    email: `custom-${seq++}-${Date.now()}@example.com`,
    name: 'Custom',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const definition = await adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: `Custom ${permissions.join('+')}`,
      permissions,
    },
  });
  await adminDb.$transaction(async (tx) => {
    await projectMembershipRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        userId: user.id,
        role: CUSTOM_ROLE_TIER,
      },
      tx,
    );
    await projectMembershipRepository.setRoleDefinition(
      user.id,
      fx.projectId,
      { roleDefinitionId: definition.id, role: CUSTOM_ROLE_TIER },
      tx,
    );
  });
  return user;
}

const ctxOf = (fx: WorkItemFixture, userId: string) => ({ userId, workspaceId: fx.workspaceId });

describe('setSyncDirections — the gate is the PERMISSION, asserted with a custom role', () => {
  it('refuses project:browse without integration:manage, and admits a role holding it', async () => {
    const { fx, connectionId } = await seed();
    const browser = await customMember(fx, ['project:browse']);
    await expect(
      monitorConnectionService.setSyncDirections(
        fx.projectId,
        connectionId,
        { resolveOnDone: false },
        ctxOf(fx, browser.id),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', permission: 'integration:manage' });
    expect((await storedRow(connectionId)).resolveOnDone).toBe(true);

    const manager = await customMember(fx, ['project:browse', 'integration:manage']);
    const dto = await monitorConnectionService.setSyncDirections(
      fx.projectId,
      connectionId,
      { resolveOnDone: false },
      ctxOf(fx, manager.id),
    );
    expect(dto.resolveOnDone).toBe(false);
    expect((await storedRow(connectionId)).resolveOnDone).toBe(false);
  });

  it('is SPARSE — one switch leaves the other unchanged, both ways', async () => {
    const { fx, connectionId } = await seed();
    const one = await monitorConnectionService.setSyncDirections(
      fx.projectId,
      connectionId,
      { resolveOnDone: false },
      fx.ctx,
    );
    expect(one).toMatchObject({ resolveOnDone: false, syncAssignee: true });
    const two = await monitorConnectionService.setSyncDirections(
      fx.projectId,
      connectionId,
      { syncAssignee: false },
      fx.ctx,
    );
    expect(two).toMatchObject({ resolveOnDone: false, syncAssignee: false });
  });

  it('refuses an empty body, a non-boolean and a non-object with the typed code', async () => {
    const { fx, connectionId } = await seed();
    for (const input of [{}, { resolveOnDone: 'false' }, { syncAssignee: 1 }, null, 'yes']) {
      await expect(
        monitorConnectionService.setSyncDirections(fx.projectId, connectionId, input, fx.ctx),
      ).rejects.toMatchObject({ code: 'INVALID_MONITOR_SYNC_DIRECTION' });
    }
    expect(await storedRow(connectionId)).toMatchObject({
      resolveOnDone: true,
      syncAssignee: true,
    });
  });
});

describe('PATCH accepts the switches beside minimumLevel', () => {
  it('accepts each switch alone, both, and either with minimumLevel — returning the DTO', async () => {
    const { fx, connectionId } = await seed();

    let res = await patch(fx, connectionId, { resolveOnDone: false });
    expect(res.status).toBe(200);
    expect((await res.json()) as MonitorConnectionDto).toMatchObject({
      resolveOnDone: false,
      syncAssignee: true,
    });

    res = await patch(fx, connectionId, { syncAssignee: false });
    expect((await res.json()) as MonitorConnectionDto).toMatchObject({
      resolveOnDone: false,
      syncAssignee: false,
    });

    res = await patch(fx, connectionId, { resolveOnDone: true, syncAssignee: true });
    expect((await res.json()) as MonitorConnectionDto).toMatchObject({
      resolveOnDone: true,
      syncAssignee: true,
    });

    res = await patch(fx, connectionId, { minimumLevel: 'error', resolveOnDone: false });
    expect(res.status).toBe(200);
    expect((await res.json()) as MonitorConnectionDto).toMatchObject({
      minimumLevel: 'error',
      resolveOnDone: false,
    });
    res = await patch(fx, connectionId, { minimumLevel: null, syncAssignee: false });
    expect((await res.json()) as MonitorConnectionDto).toMatchObject({
      minimumLevel: null,
      syncAssignee: false,
    });
    expect(await storedRow(connectionId)).toMatchObject({
      minimumLevel: null,
      resolveOnDone: false,
      syncAssignee: false,
    });
  });

  it('is 400 on a non-boolean switch, and all-or-nothing with a valid level beside it', async () => {
    const { fx, connectionId } = await seed();
    const res = await patch(fx, connectionId, { minimumLevel: 'error', syncAssignee: 'no' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_MONITOR_SYNC_DIRECTION');
    // Nothing moved — the level beside the bad switch was not written either.
    expect(await storedRow(connectionId)).toMatchObject({ minimumLevel: null, syncAssignee: true });

    const badLevel = await patch(fx, connectionId, { minimumLevel: 'loud', resolveOnDone: false });
    expect(((await badLevel.json()) as { code: string }).code).toBe('INVALID_MONITOR_LEVEL');
    expect((await storedRow(connectionId)).resolveOnDone).toBe(true);

    const notJson = await ONE.PATCH(
      new Request(
        `https://motir.test/api/projects/${fx.projectIdentifier}/monitors/${connectionId}`,
        { method: 'PATCH', body: 'not json' },
      ),
      { params: Promise.resolve({ key: fx.projectIdentifier, connectionId }) },
    );
    expect(notJson.status).toBe(400);
  });

  it('answers 404 for a connection in ANOTHER project', async () => {
    const mine = await seed();
    const theirs = await seed();
    signInAs(mine.fx.owner, mine.fx.workspaceId);
    const res = await patch(mine.fx, theirs.connectionId, { resolveOnDone: false });
    expect(res.status).toBe(404);
    expect((await storedRow(theirs.connectionId)).resolveOnDone).toBe(true);
    await expect(
      monitorConnectionService.setSyncDirections(
        mine.fx.projectId,
        theirs.connectionId,
        { syncAssignee: false },
        mine.fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'MONITOR_CONNECTION_NOT_FOUND' });
  });
});

describe('the view DTO carries the switches and the last sync failure', () => {
  it('reads both switches ON and no failure on a freshly bound connection', async () => {
    const { fx, connectionId } = await seed();
    const row = (await readView(fx)).connections.find((c) => c.id === connectionId)!;
    expect(row).toMatchObject({
      resolveOnDone: true,
      syncAssignee: true,
      lastSyncError: null,
      lastSyncErrorAt: null,
      lastSyncErrorWorkItemIdentifier: null,
    });
  });

  it('reads the failure the STORE wrote, verbatim, and null again once it is cleared', async () => {
    const { fx, connectionId } = await seed();
    const at = new Date('2026-09-18T11:00:00.000Z');
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
      await monitorConnectionRepository.recordSyncFailure(
        connectionId,
        {
          reason: 'You do not have permission to perform this action.',
          workItemIdentifier: 'SYN-7',
          at,
        },
        tx,
      );
    });
    const view = await readView(fx);
    expect(view.connections.find((c) => c.id === connectionId)).toMatchObject({
      lastSyncError: 'You do not have permission to perform this action.',
      lastSyncErrorAt: at.toISOString(),
      lastSyncErrorWorkItemIdentifier: 'SYN-7',
    });
    // Still no credential anywhere in the payload.
    expect(JSON.stringify(view)).not.toContain('fake-access-token');

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
      await monitorConnectionRepository.clearSyncFailure(connectionId, tx);
    });
    expect((await readView(fx)).connections[0]).toMatchObject({
      lastSyncError: null,
      lastSyncErrorAt: null,
      lastSyncErrorWorkItemIdentifier: null,
    });
  });
});
