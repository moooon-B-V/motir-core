import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';

// SCHEDULING AND CANCELLING AN ORGANIZATION'S DELETION (Story MOTIR-6306 ·
// MOTIR-6399) against a REAL Postgres — the locks, the partial unique index and the
// transfer race are properties of the database. Three boundary seams are stubbed,
// each the conventional one: the compliance gate (a route test has no cookie jar),
// the durable email queue (`sendEvent`), and the motir-ai client (an HTTP service
// this repository does not run).
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
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
const { truncateAuthTables } = await import('../helpers/db');
const { warmPool } = await import('../helpers/warmPool');
const { createTestUser, TEST_PASSWORD } = await import('../fixtures/userFixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { organizationDeletionService, STEP_UP_WINDOW_MS } =
  await import('@/lib/services/organizationDeletionService');
const {
  OrganizationClosingError,
  OrganizationDeletionAlreadyScheduledError,
  OrganizationDeletionAlreadyStartedError,
  OrganizationNameMismatchError,
  OrganizationNotFoundError,
  OrgForbiddenError,
  StepUpFailedError,
} = await import('@/lib/organizations/errors');
const route = await import('@/app/api/organizations/[orgId]/deletion/route');

const ORG_NAME = 'Acme Inc';
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  const outsider = await createTestUser();
  return { organizationId, owner, admin, member, outsider };
}

type Org = Awaited<ReturnType<typeof makeOrg>>;

function scheduleAs(org: Org, userId: string, extra: Record<string, unknown> = {}) {
  return organizationDeletionService.scheduleOrganizationDeletion({
    organizationId: org.organizationId,
    actorUserId: userId,
    confirmName: ORG_NAME,
    password: TEST_PASSWORD,
    sessionSignedInAt: new Date(),
    ...extra,
  });
}

async function nothingWritten(org: Org) {
  expect(
    await adminDb.organizationDeletionRequest.count({
      where: { organizationId: org.organizationId },
    }),
  ).toBe(0);
  const row = await adminDb.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
  expect(row.closingSince).toBeNull();
}

let org: Org;

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  // The route's 429 is asserted through the shared store (MOTIR-3067).
  pinSharedRateLimitStoreDeadline();
  org = await makeOrg();
  sendEvent.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('scheduleOrganizationDeletion', () => {
  it('schedules for the Owner with the name and password, then tells motir-ai and every member', async () => {
    const now = new Date('2026-09-26T10:00:00.000Z');
    const dto = await scheduleAs(org, org.owner.id, { now });

    const stored = await adminDb.organizationDeletionRequest.findUniqueOrThrow({
      where: { id: dto.id },
    });
    expect(dto.erasureDueAt).toBe(stored.erasureDueAt.toISOString());
    expect(stored.erasureDueAt.getTime() - now.getTime()).toBe(30 * DAY_MS);
    expect(stored).toMatchObject({ status: 'scheduled', requestedByUserId: org.owner.id });
    const row = await adminDb.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
    expect(row.closingSince?.toISOString()).toBe(now.toISOString());
    expect(ai.markOrgClosing).toHaveBeenCalledTimes(1);
    expect(ai.markOrgClosing).toHaveBeenCalledWith(org.organizationId, stored.erasureDueAt);
    const emails = sendEvent.mock.calls.filter(([name]) => name === 'email.send');
    expect(emails).toHaveLength(3); // Owner, Admin, Member
  });

  it('refuses an Admin and a Member (403) and a non-member (404), writing nothing', async () => {
    await expect(scheduleAs(org, org.admin.id)).rejects.toBeInstanceOf(OrgForbiddenError);
    await expect(scheduleAs(org, org.member.id)).rejects.toBeInstanceOf(OrgForbiddenError);
    await expect(scheduleAs(org, org.outsider.id)).rejects.toBeInstanceOf(
      OrganizationNotFoundError,
    );
    await nothingWritten(org);
    expect(ai.markOrgClosing).not.toHaveBeenCalled();
  });

  it('refuses the wrong name and a wrong or missing password, writing nothing', async () => {
    await expect(scheduleAs(org, org.owner.id, { confirmName: 'acme inc' })).rejects.toBeInstanceOf(
      OrganizationNameMismatchError,
    );
    await expect(scheduleAs(org, org.owner.id, { password: 'nope' })).rejects.toMatchObject({
      code: 'STEP_UP_FAILED',
      reason: 'wrong_password',
    });
    await expect(scheduleAs(org, org.owner.id, { password: undefined })).rejects.toBeInstanceOf(
      StepUpFailedError,
    );
    await nothingWritten(org);
  });

  it('asks a passwordless Owner for a sign-in within 10 minutes', async () => {
    await adminDb.account.updateMany({ where: { userId: org.owner.id }, data: { password: null } });
    const now = new Date();
    await expect(
      scheduleAs(org, org.owner.id, {
        password: undefined,
        now,
        sessionSignedInAt: new Date(now.getTime() - STEP_UP_WINDOW_MS - 1000),
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_FAILED', reason: 'reauth_required' });
    await nothingWritten(org);

    const dto = await scheduleAs(org, org.owner.id, {
      password: undefined,
      now,
      sessionSignedInAt: new Date(now.getTime() - 60_000),
    });
    expect(dto.status).toBe('scheduled');
  });

  it('refuses a second schedule while one is open', async () => {
    await scheduleAs(org, org.owner.id);
    await expect(scheduleAs(org, org.owner.id)).rejects.toBeInstanceOf(
      OrganizationDeletionAlreadyScheduledError,
    );
  });

  it('lets exactly one of two concurrent schedules win; the loser gets 409', async () => {
    await warmPool();
    const results = await Promise.allSettled([
      scheduleAs(org, org.owner.id),
      scheduleAs(org, org.owner.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(OrganizationDeletionAlreadyScheduledError);
    expect(
      await adminDb.organizationDeletionRequest.count({
        where: { organizationId: org.organizationId, status: 'scheduled' },
      }),
    ).toBe(1);
  });

  it('keeps the deletion scheduled when motir-ai fails, logging a warning', async () => {
    ai.markOrgClosing.mockRejectedValueOnce(new Error('motir-ai down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dto = await scheduleAs(org, org.owner.id);
    expect(dto.status).toBe('scheduled');
    expect(warn).toHaveBeenCalled();
    const row = await adminDb.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
    expect(row.closingSince).not.toBeNull();
  });
});

describe('cancelOrganizationDeletion', () => {
  it('cancels a scheduled deletion: the org reopens, motir-ai and every member are told', async () => {
    const scheduled = await scheduleAs(org, org.owner.id);
    sendEvent.mockClear();

    const result = await organizationDeletionService.cancelOrganizationDeletion({
      organizationId: org.organizationId,
      actorUserId: org.owner.id,
    });

    expect(result).toEqual({ outcome: 'cancelled', requestId: scheduled.id });
    const stored = await adminDb.organizationDeletionRequest.findUniqueOrThrow({
      where: { id: scheduled.id },
    });
    expect(stored).toMatchObject({ status: 'cancelled', cancelledByUserId: org.owner.id });
    const row = await adminDb.organization.findUniqueOrThrow({ where: { id: org.organizationId } });
    expect(row.closingSince).toBeNull();
    expect(ai.reopenOrg).toHaveBeenCalledWith(org.organizationId);
    expect(sendEvent.mock.calls.filter(([n]) => n === 'email.send')).toHaveLength(3);
  });

  it('is a no-op with nothing open, and Owner-only', async () => {
    expect(
      await organizationDeletionService.cancelOrganizationDeletion({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
      }),
    ).toEqual({ outcome: 'none', requestId: null });
    await scheduleAs(org, org.owner.id);
    await expect(
      organizationDeletionService.cancelOrganizationDeletion({
        organizationId: org.organizationId,
        actorUserId: org.admin.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });

  it('is refused once the erasure has started', async () => {
    const scheduled = await scheduleAs(org, org.owner.id);
    await adminDb.organizationDeletionRequest.update({
      where: { id: scheduled.id },
      data: { status: 'erasing', erasingStartedAt: new Date() },
    });
    await expect(
      organizationDeletionService.cancelOrganizationDeletion({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
      }),
    ).rejects.toBeInstanceOf(OrganizationDeletionAlreadyStartedError);
  });

  it('racing the sweep’s claim ends cancelled or refused as started — never both', async () => {
    await warmPool();
    const scheduled = await scheduleAs(org, org.owner.id);
    // The sweep's claim, as MOTIR-6400 makes it: lock the request row, move it to
    // `erasing` if it is still `scheduled`.
    const claim = adminDb.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "organization_deletion_request" WHERE "id" = ${scheduled.id} FOR UPDATE`;
      if (rows[0]?.status !== 'scheduled') return 'lost';
      await tx.organizationDeletionRequest.update({
        where: { id: scheduled.id },
        data: { status: 'erasing', erasingStartedAt: new Date() },
      });
      return 'claimed';
    });
    const cancel = organizationDeletionService
      .cancelOrganizationDeletion({ organizationId: org.organizationId, actorUserId: org.owner.id })
      .then(
        (r) => r.outcome,
        (e: unknown) => (e instanceof OrganizationDeletionAlreadyStartedError ? 'started' : e),
      );
    const [claimed, cancelled] = await Promise.all([claim, cancel]);
    const final = await adminDb.organizationDeletionRequest.findUniqueOrThrow({
      where: { id: scheduled.id },
    });
    if (claimed === 'claimed') {
      expect(cancelled).toBe('started');
      expect(final.status).toBe('erasing');
    } else {
      expect(cancelled).toBe('cancelled');
      expect(final.status).toBe('cancelled');
    }
  });
});

describe('transfer while closing', () => {
  it('is refused with ORGANIZATION_CLOSING', async () => {
    await scheduleAs(org, org.owner.id);
    await expect(
      organizationsService.transferOwnership({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
        toUserId: org.admin.id,
        confirmName: ORG_NAME,
      }),
    ).rejects.toBeInstanceOf(OrganizationClosingError);
  });
});

describe('getOrganizationDeletion', () => {
  it('shows any member the open request and who scheduled it; nothing for a non-member', async () => {
    expect(
      await organizationDeletionService.getOrganizationDeletion(org.organizationId, org.member.id),
    ).toEqual({ request: null, scheduledByName: null });
    const scheduled = await scheduleAs(org, org.owner.id);
    const state = await organizationDeletionService.getOrganizationDeletion(
      org.organizationId,
      org.member.id,
    );
    expect(state.request?.id).toBe(scheduled.id);
    expect(state.scheduledByName).toBe(org.owner.name);
    await expect(
      organizationDeletionService.getOrganizationDeletion(org.organizationId, org.outsider.id),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });
});

describe('the /deletion route', () => {
  function as(user: { id: string; email: string }, signedInAt = new Date()) {
    requireCompliantSession.mockResolvedValue({
      ok: true,
      session: {
        user: { id: user.id, email: user.email },
        session: { createdAt: signedInAt },
      },
    });
  }
  const ctx = () => ({ params: Promise.resolve({ orgId: org.organizationId }) });
  const post = (body: unknown) =>
    route.POST(
      new Request(`http://localhost/api/organizations/${org.organizationId}/deletion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      ctx(),
    );

  it('schedules (200), reads (200) and cancels (200)', async () => {
    as(org.owner);
    const res = await post({ confirmName: ORG_NAME, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; erasureDueAt: string };
    expect(body.status).toBe('scheduled');

    as(org.member);
    const read = await route.GET(new Request('http://localhost'), ctx());
    expect(read.status).toBe(200);

    as(org.owner);
    const del = await route.DELETE(new Request('http://localhost', { method: 'DELETE' }), ctx());
    expect(await del.json()).toEqual({ outcome: 'cancelled' });
  });

  it('maps the refusals: 403 Admin, 422 name, 403 step-up with reason, 409 already scheduled, 400 body', async () => {
    as(org.admin);
    expect((await post({ confirmName: ORG_NAME, password: TEST_PASSWORD })).status).toBe(403);
    as(org.owner);
    expect((await post({ confirmName: 'Wrong', password: TEST_PASSWORD })).status).toBe(422);
    const step = await post({ confirmName: ORG_NAME, password: 'bad' });
    expect(step.status).toBe(403);
    expect(await step.json()).toMatchObject({ code: 'STEP_UP_FAILED', reason: 'wrong_password' });
    expect((await post({ password: TEST_PASSWORD })).status).toBe(400);
    expect((await post({ confirmName: ORG_NAME, password: TEST_PASSWORD })).status).toBe(200);
    expect((await post({ confirmName: ORG_NAME, password: TEST_PASSWORD })).status).toBe(409);
  });

  it('rate-limits repeated attempts (429)', async () => {
    as(org.owner);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await post({ confirmName: ORG_NAME, password: 'bad' })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 403)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
