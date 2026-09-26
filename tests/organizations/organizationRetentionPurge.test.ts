import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// THE RETENTION PURGE (Story MOTIR-6306 · MOTIR-6401;
// `docs/decisions/organization-deletion.md` §7) against a REAL Postgres. Every
// tombstone here is a REAL one — written by the erasure sweep, not hand-built —
// so the cascade set under test is the one production leaves behind. motir-ai's
// purge is the injected, counted seam; the clock is an argument.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const sendEvent = vi.hoisted(() => vi.fn(async (_name: string, _data: unknown) => undefined));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent }));

const { db } = await import('@/lib/db');
const { truncateAuthTables, truncateJobRuns } = await import('../helpers/db');
const { createTestUser } = await import('../fixtures/userFixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationDeletionNotifier } =
  await import('@/lib/services/organizationDeletionNotifier');
const { organizationErasureSweepService } =
  await import('@/lib/services/organizationErasureSweepService');
const { organizationRetentionPurgeService } =
  await import('@/lib/services/organizationRetentionPurgeService');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { organizationRetentionPurge } =
  await import('@/lib/jobs/definitions/organizationRetentionPurge');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2033-10-01T12:00:00.000Z');

/** `NOW` minus seven calendar years, shifted by `days`. */
function sevenYearsBefore(days: number): Date {
  const d = new Date(NOW.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - 7);
  return new Date(d.getTime() + days * DAY_MS);
}

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  await adminDb.ciPeriodCharge.create({
    data: {
      organizationId,
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      chargedCredits: 9,
    },
  });
  return { organizationId, owner };
}

/** A real tombstone: scheduled, erased by the sweep, `erasedAt` moved to `erasedAt`. */
async function makeTombstone(erasedAt: Date) {
  const org = await makeOrg();
  await adminDb.organization.update({
    where: { id: org.organizationId },
    data: { closingSince: new Date() },
  });
  const request = await adminDb.organizationDeletionRequest.create({
    data: {
      organizationId: org.organizationId,
      requestedByUserId: org.owner.id,
      erasureDueAt: new Date(Date.now() - DAY_MS),
    },
  });
  const summary = await organizationErasureSweepService.runDue(new Date(), {
    offboardGit: async () => ({}),
    offboardAi: async () => ({ erased: true }),
    markClosing: async () => ({}),
    deleteWorkspace: (input) => workspacesService.deleteWorkspaceForOrganizationErasure(input),
    notifyErased: (input) => organizationDeletionNotifier.notifyErased(input),
  });
  expect(summary.erased).toBe(1);
  await adminDb.organizationDeletionRequest.update({
    where: { id: request.id },
    data: { erasedAt },
  });
  await adminDb.organization.update({ where: { id: org.organizationId }, data: { erasedAt } });
  return { ...org, requestId: request.id };
}

async function exists(organizationId: string) {
  return {
    org: (await adminDb.organization.count({ where: { id: organizationId } })) === 1,
    requests: await adminDb.organizationDeletionRequest.count({ where: { organizationId } }),
    charges: await adminDb.ciPeriodCharge.count({ where: { organizationId } }),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('an erased organization’s billing record expires after seven years', () => {
  it('purges a tombstone erased seven years plus a day ago — org, request and billing rows', async () => {
    const old = await makeTombstone(sevenYearsBefore(-1));
    const purgeAi = vi.fn(async (_id: string) => ({ purged: true }));

    const summary = await organizationRetentionPurgeService.runDue(NOW, { purgeAi });

    expect(summary).toMatchObject({ scanned: 1, purged: 1, failed: 0 });
    expect(purgeAi).toHaveBeenCalledTimes(1);
    expect(purgeAi).toHaveBeenCalledWith(old.organizationId);
    expect(await exists(old.organizationId)).toEqual({ org: false, requests: 0, charges: 0 });
    expect(
      await adminDb.organizationDeletionNotice.count({ where: { requestId: old.requestId } }),
    ).toBe(0);
  });

  it('leaves a tombstone erased seven years minus a day ago, and a live org, untouched', async () => {
    const young = await makeTombstone(sevenYearsBefore(1));
    const live = await makeOrg();
    const purgeAi = vi.fn(async (_id: string) => ({ purged: true }));

    const summary = await organizationRetentionPurgeService.runDue(NOW, { purgeAi });

    expect(summary).toMatchObject({ scanned: 0, purged: 0 });
    expect(purgeAi).not.toHaveBeenCalled();
    expect(await exists(young.organizationId)).toEqual({ org: true, requests: 1, charges: 1 });
    expect(await exists(live.organizationId)).toEqual({ org: true, requests: 0, charges: 1 });
    expect(await adminDb.workspace.count({ where: { organizationId: live.organizationId } })).toBe(
      1,
    );
  });

  it('a motir-ai failure leaves the tombstone in place, and the next run completes it', async () => {
    const old = await makeTombstone(sevenYearsBefore(-30));
    const failing = vi.fn(async () => {
      throw new Error('motir-ai 503');
    });

    const first = await organizationRetentionPurgeService.runDue(NOW, { purgeAi: failing });
    expect(first).toMatchObject({ scanned: 1, purged: 0, failed: 1 });
    expect(first.failures).toEqual([{ organizationId: old.organizationId, error: 'motir-ai 503' }]);
    expect(await exists(old.organizationId)).toEqual({ org: true, requests: 1, charges: 1 });

    const purgeAi = vi.fn(async (_id: string) => ({ purged: true }));
    const second = await organizationRetentionPurgeService.runDue(NOW, { purgeAi });
    expect(second).toMatchObject({ purged: 1, failed: 0 });
    expect(purgeAi).toHaveBeenCalledTimes(1);
    expect(await exists(old.organizationId)).toEqual({ org: false, requests: 0, charges: 0 });
  });

  it('is a registered daily system job', () => {
    expect(jobDefinitions).toContain(organizationRetentionPurge);
  });
});
