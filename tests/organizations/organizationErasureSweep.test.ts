import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// THE ORGANIZATION ERASURE SWEEP (Story MOTIR-6306 · MOTIR-6400;
// `docs/decisions/organization-deletion.md` §6–§7) against a REAL Postgres — the
// claim's lock, the cascade the workspace step rides and the tombstone's RLS
// binding are properties of the database, not of the code.
//
// The two REMOTE steps are injected (`ErasureSweepDeps`), so each call is counted
// and a failure can be staged: Git offboarding talks to GitHub/GitLab and motir-ai
// is an HTTP service this repository does not run. The workspace delete and the
// erased notice are the LIVE ones; the notice's durable queue (`sendEvent`) is the
// conventional stub.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const sendEvent = vi.hoisted(() => vi.fn(async (_name: string, _data: unknown) => undefined));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent }));
const ai = vi.hoisted(() => ({
  markOrgClosing: vi.fn(async () => ({ changed: true, closing: true })),
  reopenOrg: vi.fn(async () => ({ changed: true, closing: false })),
}));
vi.mock('@/lib/ai/motirAiClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/motirAiClient')>()),
  markOrgClosing: ai.markOrgClosing,
  reopenOrg: ai.reopenOrg,
}));

const { db } = await import('@/lib/db');
const { truncateAuthTables, truncateJobRuns } = await import('../helpers/db');
const { createTestUser, TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { organizationDeletionService } = await import('@/lib/services/organizationDeletionService');
const { organizationDeletionNotifier } =
  await import('@/lib/services/organizationDeletionNotifier');
const { accountErasureService } = await import('@/lib/services/accountErasureService');
const { organizationErasureSweepService, ERASED_ORGANIZATION_NAME } =
  await import('@/lib/services/organizationErasureSweepService');
const { OrganizationDeletionAlreadyStartedError, OrganizationNotErasingError } =
  await import('@/lib/organizations/errors');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { organizationErasureSweep, ORGANIZATION_ERASURE_SWEEP_CRON } =
  await import('@/lib/jobs/definitions/organizationErasureSweep');

type Deps = import('@/lib/services/organizationErasureSweepService').ErasureSweepDeps;

const ORG_NAME = 'Acme Inc';
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme one',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { name: ORG_NAME, requiresTwoFactor: true, aiIncludedSeat: true },
  });
  const second = await workspacesService.createWorkspace({
    name: 'Acme two',
    ownerUserId: owner.id,
    organizationId,
  });
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return {
    organizationId,
    workspaceIds: [workspace.id, second.workspace.id],
    owner,
    admin,
    member,
  };
}

type Org = Awaited<ReturnType<typeof makeOrg>>;

/** Schedule the deletion as the Owner, then move its due date into the past. */
async function scheduleDue(org: Org) {
  const request = await organizationDeletionService.scheduleOrganizationDeletion({
    organizationId: org.organizationId,
    actorUserId: org.owner.id,
    confirmName: ORG_NAME,
    password: TEST_PASSWORD,
    sessionSignedInAt: new Date(),
  });
  await adminDb.organizationDeletionRequest.update({
    where: { id: request.id },
    data: { erasureDueAt: new Date(Date.now() - DAY_MS) },
  });
  return request.id;
}

/** The remote steps as counted fakes; the workspace delete and the notice are live. */
function baseDeps() {
  return {
    offboardGit: vi.fn(async (_id: string): Promise<unknown> => ({})),
    offboardAi: vi.fn(async (_id: string): Promise<unknown> => ({ erased: true })),
    markClosing: vi.fn(async (_id: string, _dueAt: Date): Promise<unknown> => ({})),
    deleteWorkspace: vi.fn(
      (input: Parameters<Deps['deleteWorkspace']>[0]): Promise<void> =>
        workspacesService.deleteWorkspaceForOrganizationErasure(input),
    ),
    notifyErased: vi.fn(
      (input: Parameters<Deps['notifyErased']>[0]): Promise<void> =>
        organizationDeletionNotifier.notifyErased(input),
    ),
  };
}

function fakeDeps(overrides: Partial<ReturnType<typeof baseDeps>> = {}) {
  return { ...baseDeps(), ...overrides };
}

const requestRow = (id: string) =>
  adminDb.organizationDeletionRequest.findUniqueOrThrow({ where: { id } });
const orgRow = (id: string) => adminDb.organization.findUniqueOrThrow({ where: { id } });
const workspaceCount = (organizationId: string) =>
  adminDb.workspace.count({ where: { organizationId } });

async function seedBilling(org: Org) {
  const periodStart = new Date('2026-08-01T00:00:00.000Z');
  await adminDb.ciPeriodCharge.create({
    data: { organizationId: org.organizationId, periodStart, chargedCredits: 42 },
  });
  await adminDb.ciPeriodUsage.create({
    data: {
      organizationId: org.organizationId,
      workspaceId: org.workspaceIds[0]!,
      periodStart,
      billableMinutes: 17,
    },
  });
}

let org: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  vi.clearAllMocks();
  org = await makeOrg();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a due organization is erased to a tombstone holding only its billing record', () => {
  it('erases Git, both workspaces, the AI tenant and the identity — and keeps CiPeriodCharge', async () => {
    await seedBilling(org);
    const requestId = await scheduleDue(org);
    // Before: the Owner of a SHARED org is blocked from erasing their own account.
    expect(
      (await accountErasureService.previewAccountErasure(org.owner.id)).blockingOrganization,
    ).not.toBeNull();

    const deps = fakeDeps();
    const summary = await organizationErasureSweepService.runDue(new Date(), deps);

    expect(summary).toMatchObject({ scanned: 1, claimed: 1, erased: 1, failed: 0 });
    expect(await workspaceCount(org.organizationId)).toBe(0);
    expect(deps.offboardGit).toHaveBeenCalledTimes(1);
    expect(deps.offboardGit).toHaveBeenCalledWith(org.organizationId);
    expect(deps.offboardAi).toHaveBeenCalledTimes(1);
    expect(deps.offboardAi).toHaveBeenCalledWith(org.organizationId);
    // Git FIRST (§6.1): the repository list cascades with the workspaces.
    expect(deps.offboardGit.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deleteWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(deps.deleteWorkspace.mock.invocationCallOrder.at(-1)).toBeLessThan(
      deps.offboardAi.mock.invocationCallOrder[0]!,
    );

    expect(
      await adminDb.organizationMembership.count({
        where: { organizationId: org.organizationId },
      }),
    ).toBe(0);
    const tomb = await orgRow(org.organizationId);
    expect(tomb.name).toBe(ERASED_ORGANIZATION_NAME);
    expect(tomb.slug).not.toContain('acme');
    expect(tomb.erasedAt).not.toBeNull();
    expect(tomb.closingSince).toBeNull();
    expect(tomb).toMatchObject({ requiresTwoFactor: false, aiIncludedSeat: false, isMeta: false });
    expect(await requestRow(requestId)).toMatchObject({
      status: 'erased',
      erasureStep: 'tombstone',
      lastError: null,
    });

    // §7: the charge record survives; the meters went with their workspace.
    expect(
      await adminDb.ciPeriodCharge.findMany({ where: { organizationId: org.organizationId } }),
    ).toEqual([expect.objectContaining({ chargedCredits: 42 })]);
    expect(
      await adminDb.ciPeriodUsage.count({ where: { organizationId: org.organizationId } }),
    ).toBe(0);

    // The erased notice goes to the Owner and the Admin, not the Member.
    expect(deps.notifyErased).toHaveBeenCalledTimes(1);
    const { recipients, organizationName } = deps.notifyErased.mock.calls[0]![0];
    expect(organizationName).toBe(ORG_NAME);
    expect(recipients.map((r) => r.userId).sort()).toEqual([org.owner.id, org.admin.id].sort());
  });

  it('is gone from every former member’s org switcher, and the Owner is no longer blocked', async () => {
    await scheduleDue(org);
    await organizationErasureSweepService.runDue(new Date(), fakeDeps());

    for (const user of [org.owner, org.admin, org.member]) {
      const orgs = await organizationsService.listUserOrganizations(user.id);
      expect(orgs.map((o) => o.id)).not.toContain(org.organizationId);
    }
    expect(
      (await accountErasureService.previewAccountErasure(org.owner.id)).blockingOrganization,
    ).toBeNull();
  });

  it('leaves a request that is not yet due alone, and re-sends the closing call for it', async () => {
    const request = await organizationDeletionService.scheduleOrganizationDeletion({
      organizationId: org.organizationId,
      actorUserId: org.owner.id,
      confirmName: ORG_NAME,
      password: TEST_PASSWORD,
      sessionSignedInAt: new Date(),
    });
    const deps = fakeDeps();
    const summary = await organizationErasureSweepService.runDue(new Date(), deps);

    expect(summary).toMatchObject({ scanned: 0, erased: 0, reconciled: 1 });
    expect(deps.markClosing).toHaveBeenCalledWith(
      org.organizationId,
      new Date(request.erasureDueAt),
    );
    expect(deps.offboardGit).not.toHaveBeenCalled();
    expect(await workspaceCount(org.organizationId)).toBe(2);
    expect((await requestRow(request.id)).status).toBe('scheduled');
  });

  it('a second run over an erased organization does nothing', async () => {
    await scheduleDue(org);
    await organizationErasureSweepService.runDue(new Date(), fakeDeps());
    const again = fakeDeps();
    const summary = await organizationErasureSweepService.runDue(new Date(), again);
    expect(summary).toMatchObject({ scanned: 0, erased: 0 });
    expect(again.offboardGit).not.toHaveBeenCalled();
    expect(again.offboardAi).not.toHaveBeenCalled();
    expect(again.notifyErased).not.toHaveBeenCalled();
  });
});

describe('an interrupted run resumes from the step it reached', () => {
  it('a run killed mid-way through the workspaces is finished by the next, with no step repeated', async () => {
    const requestId = await scheduleDue(org);

    // The "kill": the second workspace delete never returns, exactly as a process
    // that exited there would leave it — Git recorded, one workspace gone.
    let deleted = 0;
    const first = fakeDeps({
      deleteWorkspace: vi.fn(async (input) => {
        if (deleted === 1) return new Promise<void>(() => {});
        await workspacesService.deleteWorkspaceForOrganizationErasure(input);
        deleted += 1;
      }),
    });
    void organizationErasureSweepService.runDue(new Date(), first);
    await vi.waitFor(async () => expect(await workspaceCount(org.organizationId)).toBe(1), {
      timeout: 15_000,
    });
    expect(await requestRow(requestId)).toMatchObject({ status: 'erasing', erasureStep: 'git' });

    const second = fakeDeps();
    const summary = await organizationErasureSweepService.runDue(new Date(), second);

    expect(summary).toMatchObject({ scanned: 1, resumed: 1, claimed: 0, erased: 1 });
    expect(second.offboardGit).not.toHaveBeenCalled();
    expect(first.offboardGit).toHaveBeenCalledTimes(1);
    expect(second.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(first.offboardAi).not.toHaveBeenCalled();
    expect(second.offboardAi).toHaveBeenCalledTimes(1);
    expect(await workspaceCount(org.organizationId)).toBe(0);
    expect((await requestRow(requestId)).status).toBe('erased');
  });

  it('a motir-ai failure stops the org at `workspaces` with lastError, and the next run completes it', async () => {
    const requestId = await scheduleDue(org);
    const failing = fakeDeps({
      offboardAi: vi.fn(async () => {
        throw new Error('motir-ai 503');
      }),
    });
    const first = await organizationErasureSweepService.runDue(new Date(), failing);

    expect(first).toMatchObject({ erased: 0, failed: 1 });
    expect(first.failures).toEqual([
      expect.objectContaining({ requestId, step: 'ai', error: 'motir-ai 503' }),
    ]);
    const stuck = await requestRow(requestId);
    expect(stuck).toMatchObject({ status: 'erasing', erasureStep: 'workspaces' });
    expect(stuck.lastError).toContain('motir-ai 503');
    expect((await orgRow(org.organizationId)).name).toBe(ORG_NAME);

    const retry = fakeDeps();
    const second = await organizationErasureSweepService.runDue(new Date(), retry);
    expect(second).toMatchObject({ resumed: 1, erased: 1, failed: 0 });
    expect(retry.offboardGit).not.toHaveBeenCalled();
    expect(retry.deleteWorkspace).not.toHaveBeenCalled();
    expect(retry.offboardAi).toHaveBeenCalledTimes(1);
    expect(await requestRow(requestId)).toMatchObject({ status: 'erased', lastError: null });
  });
});

describe('the cancel the claim races', () => {
  it('a cancel that commits before the claim leaves the organization untouched', async () => {
    const requestId = await scheduleDue(org);
    // The cancel holds the request's lock while the sweep reaches for it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const cancelTx = withSystemContext(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organization_deletion_request WHERE id = ${requestId} FOR UPDATE`;
      locked();
      await held;
      await tx.organizationDeletionRequest.update({
        where: { id: requestId },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: org.owner.id },
      });
    });
    await lockTaken;

    const deps = fakeDeps();
    const sweep = organizationErasureSweepService.runDue(new Date(), deps);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await cancelTx;
    const summary = await sweep;

    expect(summary).toMatchObject({ claimed: 0, erased: 0 });
    expect(deps.offboardGit).not.toHaveBeenCalled();
    expect(await workspaceCount(org.organizationId)).toBe(2);
    expect((await orgRow(org.organizationId)).name).toBe(ORG_NAME);
    expect((await requestRow(requestId)).status).toBe('cancelled');
  });

  it('a cancel after the claim is refused', async () => {
    const requestId = await scheduleDue(org);
    const failing = fakeDeps({
      offboardGit: vi.fn(async () => {
        throw new Error('github 500');
      }),
    });
    await organizationErasureSweepService.runDue(new Date(), failing);
    expect((await requestRow(requestId)).status).toBe('erasing');

    await expect(
      organizationDeletionService.cancelOrganizationDeletion({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
      }),
    ).rejects.toBeInstanceOf(OrganizationDeletionAlreadyStartedError);
    expect((await requestRow(requestId)).status).toBe('erasing');
  });

  it('the erasure-only workspace delete refuses a request that is not erasing', async () => {
    const requestId = await scheduleDue(org);
    await expect(
      workspacesService.deleteWorkspaceForOrganizationErasure({
        workspaceId: org.workspaceIds[0]!,
        requestId,
        actorUserId: org.owner.id,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotErasingError);
    expect(await workspaceCount(org.organizationId)).toBe(2);
  });
});

describe('the sweep is a registered hourly system job', () => {
  it('is mounted by the registry on the hour', () => {
    expect(jobDefinitions).toContain(organizationErasureSweep);
    expect(ORGANIZATION_ERASURE_SWEEP_CRON).toBe('0 * * * *');
  });
});
