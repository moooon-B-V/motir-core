import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { JobTestEngine } from '../helpers/jobs';

// THE ORG-DELETION GATE's TOP-UP (Story MOTIR-6306 · MOTIR-6404) — the arms the
// per-card suites and the lifecycle gate
// (`tests/integration/organizations/organizationDeletionLifecycle.test.ts`) leave
// unexercised, each a real behaviour rather than a line to colour in:
//
//   - the three cron jobs actually run their service;
//   - every service's LIVE dependency bag is the one a default call uses;
//   - the route's gate, body and unmapped-error arms;
//   - the defensive fallbacks: a scheduler whose account is gone, a non-Error
//     thrown by a remote, a GitLab connection with no stored tokens, an org with no
//     Owner row when a reminder goes out, a notice recorded twice at once;
//   - the retention purge never deletes an organization that is not erased, even
//     when an erased request names it.
//
// Against the real Postgres; the remote seams are stubbed exactly as the per-card
// suites stub them.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
const sendEvent = vi.hoisted(() => vi.fn(async (_name: string, _data: unknown) => undefined));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent }));
const ai = vi.hoisted(() => ({
  markOrgClosing: vi.fn(async () => ({ changed: true, closing: true })),
  reopenOrg: vi.fn(async () => ({ changed: true, closing: false })),
  offboardOrg: vi.fn(async () => ({ erased: true })),
  purgeOrgRetained: vi.fn(async () => ({ purged: true })),
}));
vi.mock('@/lib/ai/motirAiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/motirAiClient')>()),
  ...ai,
}));

const { db } = await import('@/lib/db');
const { truncateAuthTables, truncateJobRuns } = await import('../helpers/db');
const { createTestUser, TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { organizationDeletionService } = await import('@/lib/services/organizationDeletionService');
const { organizationDeletionNotifier } =
  await import('@/lib/services/organizationDeletionNotifier');
const { organizationErasureSweepService } =
  await import('@/lib/services/organizationErasureSweepService');
const { organizationRetentionPurgeService } =
  await import('@/lib/services/organizationRetentionPurgeService');
const { organizationGitOffboardingService } =
  await import('@/lib/services/organizationGitOffboardingService');
const { repoDeletionClient } = await import('@/lib/github/repoDeletion');
const { appInstallationsClient } = await import('@/lib/github/appInstallations');
const { organizationErasureSweep } =
  await import('@/lib/jobs/definitions/organizationErasureSweep');
const { organizationRetentionPurge } =
  await import('@/lib/jobs/definitions/organizationRetentionPurge');
const { organizationDeletionReminders } =
  await import('@/lib/jobs/definitions/organizationDeletionReminders');
const route = await import('@/app/api/organizations/[orgId]/deletion/route');
const { assertWorkspaceOrgNotClosing } = await import('@/lib/organizations/closingGuard');
const { OrganizationClosingError } = await import('@/lib/organizations/errors');

const HOST = 'motir-projects';
const DAY_MS = 24 * 60 * 60 * 1000;
const ORG_NAME = 'Acme Inc';

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme ws',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  await adminDb.organization.update({ where: { id: organizationId }, data: { name: ORG_NAME } });
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  return { organizationId, workspaceId: workspace.id, owner, admin };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

function schedule(org: Org) {
  return organizationDeletionService.scheduleOrganizationDeletion({
    organizationId: org.organizationId,
    actorUserId: org.owner.id,
    confirmName: ORG_NAME,
    password: TEST_PASSWORD,
    sessionSignedInAt: new Date(),
  });
}

async function scheduleDue(org: Org) {
  const request = await schedule(org);
  await adminDb.organizationDeletionRequest.update({
    where: { id: request.id },
    data: { erasureDueAt: new Date(Date.now() - DAY_MS) },
  });
  return request.id;
}

let seq = 0;
async function gitRows(org: Org) {
  seq += 1;
  const provisioning = await adminDb.githubInstallation.create({
    data: {
      provider: 'github',
      installationId: `prov-${seq}`,
      workspaceId: null,
      organizationId: null,
      accountLogin: HOST,
      accountType: 'Organization',
    },
  });
  const own = await adminDb.githubInstallation.create({
    data: {
      provider: 'github',
      installationId: `own-${seq}`,
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
  const gitlab = await adminDb.githubInstallation.create({
    // A GitLab connection whose tokens were never stored (or were cleared).
    data: {
      provider: 'gitlab',
      installationId: `gl-${seq}`,
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      accountLogin: 'acme-gl',
      accountType: 'Organization',
    },
  });
  const repo = (installationId: string, owner: string, name: string, provider = 'github') =>
    adminDb.githubRepo.create({
      data: {
        provider: provider as 'github' | 'gitlab',
        installationId,
        workspaceId: org.workspaceId,
        organizationId: org.organizationId,
        repoId: `r-${seq}-${name}`,
        owner,
        name,
        defaultBranch: 'main',
      },
    });
  await repo(provisioning.id, HOST, 'hosted-site');
  await repo(own.id, 'acme', 'their-app');
  await repo(gitlab.id, 'acme-gl', 'gl-app', 'gitlab');
  return { provisioning, own, gitlab };
}

let org: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.githubInstallation.deleteMany({});
  vi.clearAllMocks();
  // motir-ai is CONFIGURED for this file (its client is mocked above); the
  // unconfigured deployment has its own case below.
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  org = await makeOrg();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the three cron jobs run their service', () => {
  it('the erasure sweep job erases a due organization', async () => {
    await scheduleDue(org);
    const { result } = await new JobTestEngine({ function: organizationErasureSweep }).execute();
    expect(result).toMatchObject({ scanned: 1, erased: 1 });
  });

  it('the retention purge job purges an expired tombstone', async () => {
    const id = await scheduleDue(org);
    await organizationErasureSweepService.runDue();
    const longAgo = new Date(Date.now() - 8 * 365 * DAY_MS);
    await adminDb.organizationDeletionRequest.update({
      where: { id },
      data: { erasedAt: longAgo },
    });
    const { result } = await new JobTestEngine({ function: organizationRetentionPurge }).execute();
    expect(result).toMatchObject({ scanned: 1, purged: 1 });
    expect(ai.purgeOrgRetained).toHaveBeenCalledWith(org.organizationId);
    expect(await adminDb.organization.count({ where: { id: org.organizationId } })).toBe(0);
  });

  it('the reminder job sends the one-day reminder', async () => {
    const request = await schedule(org);
    await adminDb.organizationDeletionRequest.update({
      where: { id: request.id },
      data: { erasureDueAt: new Date(Date.now() + 12 * 60 * 60 * 1000) },
    });
    const { result } = await new JobTestEngine({
      function: organizationDeletionReminders,
    }).execute();
    expect(result).toMatchObject({ remindersSent: 1 });
  });
});

describe('the LIVE dependency bags', () => {
  it('the sweep’s defaults reach Git, the workspace delete, motir-ai, the notice and the reconcile', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', HOST);
    await gitRows(org);
    const deleteRepo = vi.spyOn(repoDeletionClient, 'deleteRepo').mockResolvedValue('deleted');
    const uninstall = vi
      .spyOn(appInstallationsClient, 'uninstallInstallation')
      .mockResolvedValue('uninstalled');
    await scheduleDue(org);
    const pending = await makeOrg();
    await schedule(pending);

    const summary = await organizationErasureSweepService.runDue();
    expect(summary).toMatchObject({ erased: 1, reconciled: 1 });
    expect(deleteRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: HOST, repo: 'hosted-site' }),
    );
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(ai.offboardOrg).toHaveBeenCalledWith(org.organizationId);
    expect(ai.markOrgClosing).toHaveBeenCalledWith(pending.organizationId, expect.any(Date));
    expect(await adminDb.githubRepo.count({ where: { organizationId: org.organizationId } })).toBe(
      0,
    );
    // The token-less GitLab connection is removed with nothing to revoke.
    expect(
      await adminDb.githubInstallation.count({ where: { organizationId: org.organizationId } }),
    ).toBe(0);
  });

  it('with NO motir-ai configured the AI steps are skipped, and the org is still erased', async () => {
    vi.stubEnv('MOTIR_AI_URL', '');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    const id = await scheduleDue(org);
    const pending = await makeOrg();
    await schedule(pending);
    ai.markOrgClosing.mockClear();

    const summary = await organizationErasureSweepService.runDue();
    expect(summary).toMatchObject({ erased: 1, failed: 0, reconciled: 1 });
    expect(ai.offboardOrg).not.toHaveBeenCalled();
    expect(ai.markOrgClosing).not.toHaveBeenCalled();

    const longAgo = new Date(Date.now() - 8 * 365 * DAY_MS);
    await adminDb.organizationDeletionRequest.update({
      where: { id },
      data: { erasedAt: longAgo },
    });
    const purge = await organizationRetentionPurgeService.runDue();
    expect(purge).toMatchObject({ purged: 1, failed: 0 });
    expect(ai.purgeOrgRetained).not.toHaveBeenCalled();
  });

  it('Git offboarding with its default deps and no provisioning login deletes nothing remote', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    await gitRows(org);
    const deleteRepo = vi.spyOn(repoDeletionClient, 'deleteRepo');
    vi.spyOn(appInstallationsClient, 'uninstallInstallation').mockResolvedValue('uninstalled');
    const counts = await organizationGitOffboardingService.offboardGit(org.organizationId);
    expect(deleteRepo).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ hostedReposDeleted: 0, gitlabConnectionsRemoved: 1 });
  });
});

describe('the service reads', () => {
  it('getConsequences lists only the repositories Motir hosts', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', HOST);
    await gitRows(org);
    const c = await organizationDeletionService.getConsequences(
      org.organizationId,
      org.owner.id,
      new Date(),
    );
    expect(c.hostedRepos.map((r) => r.fullName)).toEqual([`${HOST}/hosted-site`]);
  });

  it('getClosingOrganizationName is null while open and the name while closing', async () => {
    expect(await organizationDeletionService.getClosingOrganizationName(org.workspaceId)).toBe(
      null,
    );
    await schedule(org);
    expect(await organizationDeletionService.getClosingOrganizationName(org.workspaceId)).toBe(
      ORG_NAME,
    );
  });

  it('the workspace closing guard passes an open org and refuses a closing one', async () => {
    await expect(
      adminDb.$transaction((tx) => assertWorkspaceOrgNotClosing(org.workspaceId, tx)),
    ).resolves.toBeUndefined();
    await schedule(org);
    await expect(
      adminDb.$transaction((tx) => assertWorkspaceOrgNotClosing(org.workspaceId, tx)),
    ).rejects.toBeInstanceOf(OrganizationClosingError);
  });

  it('getOrganizationDeletion names nobody once the scheduler’s account is gone', async () => {
    const request = await schedule(org);
    await adminDb.organizationDeletionRequest.update({
      where: { id: request.id },
      data: { requestedByUserId: null },
    });
    const state = await organizationDeletionService.getOrganizationDeletion(
      org.organizationId,
      org.admin.id,
    );
    expect(state).toMatchObject({ scheduledByName: null, request: { id: request.id } });
  });
});

describe('the route’s own arms', () => {
  const ctx = () => ({ params: Promise.resolve({ orgId: org.organizationId }) });
  const url = () => `http://localhost/api/organizations/${org.organizationId}/deletion`;
  const post = (body: string) =>
    route.POST(
      new Request(url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      ctx(),
    );
  function as(userId: string) {
    requireCompliantSession.mockResolvedValue({
      ok: true,
      session: { user: { id: userId }, session: { createdAt: new Date() } },
    });
  }

  it('answers the gate’s own response when there is no compliant session', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await route.GET(new Request(url()), ctx())).status).toBe(401);
    expect((await post('{}')).status).toBe(401);
    expect((await route.DELETE(new Request(url(), { method: 'DELETE' }), ctx())).status).toBe(401);
  });

  it('400s a body that is not JSON, null, or carries a non-string password', async () => {
    as(org.owner.id);
    expect((await post('not json')).status).toBe(400);
    expect((await post('null')).status).toBe(400);
    expect((await post(JSON.stringify({ confirmName: ORG_NAME, password: 42 }))).status).toBe(400);
  });

  it('rethrows an error it cannot map', async () => {
    as(org.owner.id);
    const boom = new Error('boom');
    vi.spyOn(organizationDeletionService, 'getOrganizationDeletion').mockRejectedValue(boom);
    vi.spyOn(organizationDeletionService, 'scheduleOrganizationDeletion').mockRejectedValue(boom);
    vi.spyOn(organizationDeletionService, 'cancelOrganizationDeletion').mockRejectedValue(boom);
    await expect(route.GET(new Request(url()), ctx())).rejects.toBe(boom);
    await expect(post(JSON.stringify({ confirmName: ORG_NAME }))).rejects.toBe(boom);
    await expect(route.DELETE(new Request(url(), { method: 'DELETE' }), ctx())).rejects.toBe(boom);
  });
});

describe('the sweep’s and the purge’s defensive arms', () => {
  const quietDeps = () => ({
    offboardGit: vi.fn(async () => ({})),
    deleteWorkspace: vi.fn(
      (input: Parameters<typeof workspacesService.deleteWorkspaceForOrganizationErasure>[0]) =>
        workspacesService.deleteWorkspaceForOrganizationErasure(input),
    ),
    offboardAi: vi.fn(async () => ({})),
    markClosing: vi.fn(async () => ({})),
    notifyErased: vi.fn(async () => undefined),
  });

  it('records a remote that throws a non-Error, under its step', async () => {
    const id = await scheduleDue(org);
    const deps = { ...quietDeps(), offboardGit: vi.fn(() => Promise.reject('plain string')) };
    const summary = await organizationErasureSweepService.runDue(new Date(), deps);
    expect(summary.failures).toEqual([{ requestId: id, step: 'git', error: 'plain string' }]);
  });

  it('erases an org whose scheduler’s account is gone', async () => {
    const id = await scheduleDue(org);
    await adminDb.organizationDeletionRequest.update({
      where: { id },
      data: { requestedByUserId: null },
    });
    const deps = quietDeps();
    const summary = await organizationErasureSweepService.runDue(new Date(), deps);
    expect(summary.erased).toBe(1);
    expect(deps.deleteWorkspace).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: '' }));
  });

  it('a notice that throws after the tombstone is recorded as `unknown`, and the org stays erased', async () => {
    const id = await scheduleDue(org);
    const deps = { ...quietDeps(), notifyErased: vi.fn(() => Promise.reject('mail down')) };
    const summary = await organizationErasureSweepService.runDue(new Date(), deps);
    expect(summary.failures).toEqual([{ requestId: id, step: 'unknown', error: 'mail down' }]);
    expect(
      (await adminDb.organizationDeletionRequest.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('erased');
  });

  it('the purge records a non-Error, and never deletes an org that is not erased', async () => {
    const id = await scheduleDue(org);
    await organizationErasureSweepService.runDue(new Date(), quietDeps());
    const longAgo = new Date(Date.now() - 8 * 365 * DAY_MS);
    await adminDb.organizationDeletionRequest.update({
      where: { id },
      data: { erasedAt: longAgo },
    });

    const failed = await organizationRetentionPurgeService.runDue(new Date(), {
      purgeAi: () => Promise.reject('ai down'),
    });
    expect(failed.failures).toEqual([{ organizationId: org.organizationId, error: 'ai down' }]);

    // An erased REQUEST naming an org whose own `erasedAt` is not set: the delete's
    // predicate refuses it.
    await adminDb.organization.update({
      where: { id: org.organizationId },
      data: { erasedAt: null },
    });
    const guarded = await organizationRetentionPurgeService.runDue(new Date(), {
      purgeAi: async () => ({}),
    });
    expect(guarded).toMatchObject({ scanned: 1, purged: 0, failed: 0 });
    expect(await adminDb.organization.count({ where: { id: org.organizationId } })).toBe(1);
  });
});

describe('the notifier’s fallbacks', () => {
  it('a cancel notice for a request that is gone sends nothing', async () => {
    await organizationDeletionNotifier.notifyCancelled('no-such-request');
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('names the org when the canceller is not on the roster', async () => {
    const request = await schedule(org);
    await adminDb.organizationDeletionRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: null },
    });
    sendEvent.mockClear();
    await organizationDeletionNotifier.notifyCancelled(request.id);
    const data = sendEvent.mock.calls.map(([, d]) => d as { data: { cancelledByName: string } });
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.data.cancelledByName === ORG_NAME)).toBe(true);
  });

  it('two erased notices at once record ONE notice', async () => {
    const request = await schedule(org);
    const input = {
      requestId: request.id,
      organizationName: ORG_NAME,
      erasedAt: new Date(),
      recipients: [],
    };
    await Promise.all([
      organizationDeletionNotifier.notifyErased(input),
      organizationDeletionNotifier.notifyErased(input),
    ]);
    expect(
      await adminDb.organizationDeletionNotice.count({
        where: { requestId: request.id, kind: 'erased' },
      }),
    ).toBe(1);
  });

  it('a reminder with no Owner on the roster names the org instead', async () => {
    const request = await schedule(org);
    await adminDb.organizationDeletionRequest.update({
      where: { id: request.id },
      data: { erasureDueAt: new Date(Date.now() + 12 * 60 * 60 * 1000) },
    });
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: org.organizationId, role: 'owner' },
      data: { role: 'admin' },
    });
    sendEvent.mockClear();
    await organizationDeletionNotifier.sendDueReminders();
    const data = sendEvent.mock.calls.map(([, d]) => d as { data: { ownerName: string } });
    expect(data.length).toBe(2);
    expect(data.every((d) => d.data.ownerName === ORG_NAME)).toBe(true);
  });
});
