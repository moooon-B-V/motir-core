import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../../helpers/adminDb';
import { motirAiLifecycleFetch } from '../../fixtures/motirAiOrgLifecycleContract';

// THE ORG-DELETION INTEGRATION GATE (Story MOTIR-6306 · MOTIR-6404) — the
// assembled motir-core lifecycle against the REAL Postgres: schedule → closing
// (read-only) → cancel, or → due → the erasure sweep → the tombstone.
//
// Each card shipped its own unit tests; this file exists for the SEAMS those
// tests stub — the row the service writes is the row the sweep selects, the
// resolver reads the `closingSince` the service wrote, the erased notice's
// recipients are captured before the tombstone drops the memberships — and for
// the races, which only a real database can decide.
//
// motir-ai is stubbed at its HTTP seam (`fetch`) with the RECORDED wire shapes of
// its three lifecycle routes (`tests/fixtures/motirAiOrgLifecycleContract.ts`,
// cited to the motir-ai files that define them). Nothing else is stubbed but the
// compliance gate a route test cannot satisfy and the durable email queue.
// These orgs host no repositories, so the Git step makes no outbound call.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
const sendEvent = vi.hoisted(() => vi.fn(async (_name: string, _data: unknown) => undefined));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent }));

const { db } = await import('@/lib/db');
const { truncateAuthTables, truncateJobRuns } = await import('../../helpers/db');
const { pinSharedRateLimitStoreDeadline } = await import('../../helpers/rateLimitStore');
const { makeWorkItemFixture } = await import('../../fixtures/workItemFixtures');
const { createTestUser, TEST_PASSWORD } = await import('../../fixtures/userFixtures');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { organizationDeletionService } = await import('@/lib/services/organizationDeletionService');
const { organizationDeletionNotifier } =
  await import('@/lib/services/organizationDeletionNotifier');
const { organizationGitOffboardingService } =
  await import('@/lib/services/organizationGitOffboardingService');
const { organizationErasureSweepService } =
  await import('@/lib/services/organizationErasureSweepService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { markOrgClosing, offboardOrg } = await import('@/lib/ai/motirAiClient');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { organizationDeletionRequestRepository } =
  await import('@/lib/repositories/organizationDeletionRequestRepository');
const { OrganizationDeletionAlreadyScheduledError, OrganizationDeletionAlreadyStartedError } =
  await import('@/lib/organizations/errors');
const route = await import('@/app/api/organizations/[orgId]/deletion/route');

type Deps = import('@/lib/services/organizationErasureSweepService').ErasureSweepDeps;

const DAY_MS = 24 * 60 * 60 * 1000;
const ORG_NAME = 'Acme Inc';

let ai: ReturnType<typeof motirAiLifecycleFetch>;

async function makeOrg(name = ORG_NAME, identifier = 'PROD') {
  const fx = await makeWorkItemFixture({ name: `${name} ws`, identifier });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } })
  ).organizationId;
  await adminDb.organization.update({ where: { id: organizationId }, data: { name } });
  const admin = await createTestUser();
  const member = await createTestUser();
  for (const [u, role] of [
    [admin, 'admin'],
    [member, 'member'],
  ] as const) {
    await organizationsService.addMember({
      organizationId,
      userId: u.id,
      role,
      actorUserId: fx.ownerId,
    });
  }
  const outsider = await createTestUser();
  const periodStart = new Date('2026-08-01T00:00:00.000Z');
  await adminDb.ciPeriodCharge.create({
    data: { organizationId, periodStart, chargedCredits: 42, debitedCredits: 40 },
  });
  await adminDb.ciPeriodUsage.create({
    data: { organizationId, workspaceId: fx.workspaceId, periodStart, billableMinutes: 17 },
  });
  return { ...fx, organizationId, name, admin, member, outsider };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

function schedule(org: Org, actorUserId = org.ownerId) {
  return organizationDeletionService.scheduleOrganizationDeletion({
    organizationId: org.organizationId,
    actorUserId,
    confirmName: org.name,
    password: TEST_PASSWORD,
    sessionSignedInAt: new Date(),
  });
}

async function makeDue(requestId: string) {
  await adminDb.organizationDeletionRequest.update({
    where: { id: requestId },
    data: { erasureDueAt: new Date(Date.now() - DAY_MS) },
  });
}

/** The LIVE deps, each counted — the sweep's own `LIVE_DEPS`, spelled out so a
 *  test can replace one step with a hang (a process that died there). */
function liveDeps(over: Partial<Record<keyof Deps, ReturnType<typeof vi.fn>>> = {}) {
  return {
    offboardGit: vi.fn((id: string) => organizationGitOffboardingService.offboardGit(id)),
    deleteWorkspace: vi.fn((input: Parameters<Deps['deleteWorkspace']>[0]) =>
      workspacesService.deleteWorkspaceForOrganizationErasure(input),
    ),
    offboardAi: vi.fn((id: string) => offboardOrg(id)),
    markClosing: vi.fn((id: string, dueAt: Date) => markOrgClosing(id, dueAt)),
    notifyErased: vi.fn((input: Parameters<Deps['notifyErased']>[0]) =>
      organizationDeletionNotifier.notifyErased(input),
    ),
    ...over,
  } as Deps & Record<keyof Deps, ReturnType<typeof vi.fn>>;
}

const hang = () => vi.fn(() => new Promise<never>(() => {}));
const requestRow = (id: string) =>
  adminDb.organizationDeletionRequest.findUniqueOrThrow({ where: { id } });
const aiCalls = (suffix: string) => ai.calls.filter((c) => c.path.endsWith(suffix));

function erasedRecipients(): string[] {
  return sendEvent.mock.calls
    .filter(([name, data]) => {
      const d = data as { template?: string } | null;
      return name === 'email.send' && d?.template === 'organization-erased';
    })
    .map(([, data]) => (data as { to: string }).to)
    .sort();
}

async function assertTombstone(org: Org) {
  const row = await adminDb.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
  expect(row.name).not.toBe(org.name);
  expect(row.erasedAt).not.toBeNull();
  expect(row.closingSince).toBeNull();
  const where = { organizationId: org.organizationId };
  expect(await adminDb.workspace.count({ where })).toBe(0);
  expect(await adminDb.organizationMembership.count({ where })).toBe(0);
  expect(await adminDb.githubRepo.count({ where })).toBe(0);
  expect(await adminDb.githubInstallation.count({ where })).toBe(0);
  // §7: the charge record survives, unchanged; the meters went with the workspace.
  expect(await adminDb.ciPeriodCharge.findMany({ where })).toEqual([
    expect.objectContaining({ chargedCredits: 42, debitedCredits: 40 }),
  ]);
  expect(await adminDb.ciPeriodUsage.count({ where })).toBe(0);
  expect(await adminDb.ciWorkflowRunUsage.count({ where })).toBe(0);
}

let org: Org;
let other: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  vi.clearAllMocks();
  pinSharedRateLimitStoreDeadline();
  ai = motirAiLifecycleFetch();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  vi.stubGlobal('fetch', ai.fetchImpl);
  org = await makeOrg();
  other = await makeOrg('Other Org', 'OTHR');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the seams', () => {
  it('schedule → read-only → due → the sweep selects the SAME row → tombstone, notice to Owner + Admin', async () => {
    const before = await projectAccessService.getCapabilities(org.projectId, org.ctx);
    expect(before.canEdit).toBe(true);

    const scheduled = await schedule(org);
    expect(aiCalls('/closing')).toEqual([
      expect.objectContaining({ method: 'POST', body: { dueAt: scheduled.erasureDueAt } }),
    ]);

    // The resolver reads the `closingSince` the service wrote — the Owner too.
    const closing = await projectAccessService.getCapabilities(org.projectId, org.ctx);
    expect(closing).toEqual({ canBrowse: true, canEdit: false });
    expect((await projectAccessService.getCapabilities(other.projectId, other.ctx)).canEdit).toBe(
      true,
    );

    // Not due yet: the sweep's selection does not see it.
    const notYet = await withSystemContext((tx) =>
      organizationDeletionRequestRepository.listDue(new Date(), 10, tx),
    );
    expect(notYet).toEqual([]);

    // At the stored due date, it is exactly that row.
    const atDue = await withSystemContext((tx) =>
      organizationDeletionRequestRepository.listDue(new Date(scheduled.erasureDueAt), 10, tx),
    );
    expect(atDue.map((r) => r.id)).toEqual([scheduled.id]);

    const summary = await organizationErasureSweepService.runDue(
      new Date(scheduled.erasureDueAt),
      liveDeps(),
    );
    expect(summary).toMatchObject({ claimed: 1, erased: 1, failed: 0 });
    expect(aiCalls('/offboard')).toHaveLength(1);
    await assertTombstone(org);

    // The recipients were read BEFORE the memberships went.
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: org.ownerId } });
    expect(erasedRecipients()).toEqual([owner.email, org.admin.email].sort());
  });

  it('a cancel restores editing and tells motir-ai to reopen', async () => {
    await schedule(org);
    const outcome = await organizationDeletionService.cancelOrganizationDeletion({
      organizationId: org.organizationId,
      actorUserId: org.ownerId,
    });
    expect(outcome).toMatchObject({ outcome: 'cancelled' });
    expect((await projectAccessService.getCapabilities(org.projectId, org.ctx)).canEdit).toBe(true);
    expect(aiCalls('/closing').map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });
});

describe('the Owner-only matrix, through the real routes', () => {
  function as(userId: string) {
    requireCompliantSession.mockResolvedValue({
      ok: true,
      session: { user: { id: userId }, session: { createdAt: new Date() } },
    });
  }
  const ctx = () => ({ params: Promise.resolve({ orgId: org.organizationId }) });
  const url = () => `http://localhost/api/organizations/${org.organizationId}/deletion`;
  const post = () =>
    route.POST(
      new Request(url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName: org.name, password: TEST_PASSWORD }),
      }),
      ctx(),
    );
  const del = () => route.DELETE(new Request(url(), { method: 'DELETE' }), ctx());
  const get = () => route.GET(new Request(url()), ctx());

  it('schedule, cancel and read × Owner, Admin, Member and non-member', async () => {
    const actors = {
      owner: org.ownerId,
      admin: org.admin.id,
      member: org.member.id,
      outsider: org.outsider.id,
    };
    const expected = {
      owner: { post: 200, del: 200, get: 200 },
      admin: { post: 403, del: 403, get: 200 },
      member: { post: 403, del: 403, get: 200 },
      outsider: { post: 404, del: 404, get: 404 },
    } as const;
    for (const who of ['admin', 'member', 'outsider'] as const) {
      as(actors[who]);
      expect({
        post: (await post()).status,
        del: (await del()).status,
        get: (await get()).status,
      }).toEqual(expected[who]);
    }
    expect(
      await adminDb.organizationDeletionRequest.count({
        where: { organizationId: org.organizationId },
      }),
    ).toBe(0);
    as(actors.owner);
    expect({
      post: (await post()).status,
      get: (await get()).status,
      del: (await del()).status,
    }).toEqual({ post: 200, get: 200, del: 200 });
  });
});

describe('the races, against the real database', () => {
  it('two schedules produce ONE row', async () => {
    const results = await Promise.allSettled([schedule(org), schedule(org)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OrganizationDeletionAlreadyScheduledError);
    expect(
      await adminDb.organizationDeletionRequest.count({
        where: { organizationId: org.organizationId },
      }),
    ).toBe(1);
  });

  it('a cancel racing the sweep’s claim — exactly one wins', async () => {
    const scheduled = await schedule(org);
    await makeDue(scheduled.id);
    const [cancel, sweep] = await Promise.allSettled([
      organizationDeletionService.cancelOrganizationDeletion({
        organizationId: org.organizationId,
        actorUserId: org.ownerId,
      }),
      organizationErasureSweepService.runDue(new Date(), liveDeps()),
    ]);
    const status = (await requestRow(scheduled.id)).status;
    if (cancel.status === 'fulfilled' && cancel.value.outcome === 'cancelled') {
      expect(status).toBe('cancelled');
      expect(sweep).toMatchObject({ status: 'fulfilled', value: { erased: 0 } });
      expect(await adminDb.workspace.count({ where: { organizationId: org.organizationId } })).toBe(
        1,
      );
    } else {
      expect(cancel.status).toBe('rejected');
      expect((cancel as PromiseRejectedResult).reason).toBeInstanceOf(
        OrganizationDeletionAlreadyStartedError,
      );
      expect(status).toBe('erased');
      await assertTombstone(org);
    }
  });

  it('a transfer racing a schedule — exactly one wins', async () => {
    const [transfer, sched] = await Promise.allSettled([
      organizationsService.transferOwnership({
        organizationId: org.organizationId,
        actorUserId: org.ownerId,
        toUserId: org.admin.id,
        confirmName: org.name,
      }),
      schedule(org),
    ]);
    const wins = [transfer, sched].filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);
    const owner = await adminDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: org.organizationId, role: 'owner' },
    });
    const open = await adminDb.organizationDeletionRequest.count({
      where: { organizationId: org.organizationId, status: 'scheduled' },
    });
    if (transfer.status === 'fulfilled') {
      expect(owner.userId).toBe(org.admin.id);
      expect(open).toBe(0);
    } else {
      expect(owner.userId).toBe(org.ownerId);
      expect(open).toBe(1);
    }
  });
});

describe('a sweep killed after each step resumes to the same end state', () => {
  async function dueRequest() {
    const scheduled = await schedule(org);
    await makeDue(scheduled.id);
    return scheduled.id;
  }

  it('killed after git (during the workspaces): git is not repeated', async () => {
    const id = await dueRequest();
    const first = liveDeps({ deleteWorkspace: hang() });
    void organizationErasureSweepService.runDue(new Date(), first);
    await vi.waitFor(async () => expect((await requestRow(id)).erasureStep).toBe('git'), {
      timeout: 15_000,
    });

    const second = liveDeps();
    await organizationErasureSweepService.runDue(new Date(), second);
    expect(first.offboardGit).toHaveBeenCalledTimes(1);
    expect(second.offboardGit).not.toHaveBeenCalled();
    expect(aiCalls('/offboard')).toHaveLength(1);
    await assertTombstone(org);
  });

  it('killed after the workspaces (during the ai step): git and workspaces are not repeated', async () => {
    const id = await dueRequest();
    const first = liveDeps({ offboardAi: hang() });
    void organizationErasureSweepService.runDue(new Date(), first);
    await vi.waitFor(async () => expect((await requestRow(id)).erasureStep).toBe('workspaces'), {
      timeout: 15_000,
    });

    const second = liveDeps();
    await organizationErasureSweepService.runDue(new Date(), second);
    expect(second.offboardGit).not.toHaveBeenCalled();
    expect(second.deleteWorkspace).not.toHaveBeenCalled();
    expect(second.offboardAi).toHaveBeenCalledTimes(1);
    await assertTombstone(org);
  });

  it('killed after the ai step (before the tombstone): only the tombstone remains to do', async () => {
    const id = await dueRequest();
    const first = liveDeps({ offboardAi: hang() });
    void organizationErasureSweepService.runDue(new Date(), first);
    await vi.waitFor(async () => expect((await requestRow(id)).erasureStep).toBe('workspaces'), {
      timeout: 15_000,
    });
    // The process died right after recording the ai step — the state it leaves.
    await offboardOrg(org.organizationId);
    await adminDb.organizationDeletionRequest.update({
      where: { id },
      data: { erasureStep: 'ai' },
    });

    const second = liveDeps();
    await organizationErasureSweepService.runDue(new Date(), second);
    expect(second.offboardGit).not.toHaveBeenCalled();
    expect(second.deleteWorkspace).not.toHaveBeenCalled();
    expect(second.offboardAi).not.toHaveBeenCalled();
    expect((await requestRow(id)).status).toBe('erased');
    await assertTombstone(org);
  });

  it('a motir-ai outage is recorded, retried on the next run, and completes', async () => {
    let down = true;
    ai = motirAiLifecycleFetch({ failOffboard: () => down });
    vi.stubGlobal('fetch', ai.fetchImpl);
    const id = await dueRequest();
    const first = await organizationErasureSweepService.runDue(new Date(), liveDeps());
    expect(first).toMatchObject({ failed: 1, erased: 0 });
    expect(await requestRow(id)).toMatchObject({ status: 'erasing', erasureStep: 'workspaces' });

    down = false;
    const second = await organizationErasureSweepService.runDue(new Date(), liveDeps());
    expect(second).toMatchObject({ resumed: 1, erased: 1 });
    await assertTombstone(org);
  });
});

describe('isolation and the architecture guard', () => {
  it('a second org is untouched by the whole lifecycle', async () => {
    const snapshot = async () => ({
      org: await adminDb.organization.findUniqueOrThrow({ where: { id: other.organizationId } }),
      workspaces: await adminDb.workspace.count({
        where: { organizationId: other.organizationId },
      }),
      members: await adminDb.organizationMembership.count({
        where: { organizationId: other.organizationId },
      }),
      usage: await adminDb.ciPeriodUsage.count({ where: { organizationId: other.organizationId } }),
    });
    const before = await snapshot();
    const scheduled = await schedule(org);
    await makeDue(scheduled.id);
    await organizationErasureSweepService.runDue(new Date(), liveDeps());
    await assertTombstone(org);
    expect(await snapshot()).toEqual(before);
  });

  it('nothing outside workspacesService deletes a workspace row', () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(relative(root, p).replace(/\\/g, '/'));
      }
    };
    walk(join(root, 'lib'));
    walk(join(root, 'app'));
    expect(files).toContain('lib/services/workspacesService.ts');
    const offenders = files
      .filter((f) => f !== 'lib/services/workspacesService.ts')
      .filter((f) => /workspaceRepository\.delete\w*\(/.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
