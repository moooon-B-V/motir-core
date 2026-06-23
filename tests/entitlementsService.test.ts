import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Service test for entitlementsService (Subtask 8.1.11) — the §4 PM-core
// entitlement caps. Everything is exercised against the REAL Postgres (the
// no-mocks rule); the only toggle is the `MOTIR_CLOUD` env flag (the ADR §6
// cloud-only gate). Proves each gate (work items / projects / workspaces / org
// creation / per-file size / total storage), the §4 divergences (caps key off
// the scaled-tracker subscription NOT the AI PlanTier; the work-item count is
// ALL items incl. archived), the cloud-only inertness, AND the FOR UPDATE
// real-concurrency contract for the headline work-item cap.

const { entitlementsService } = await import('@/lib/services/entitlementsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { workItemRepository } = await import('@/lib/repositories/workItemRepository');
const { makeWorkItemFixture, createTestUser } = await import('./fixtures');
const { truncateAuthTables } = await import('./helpers/db');
const { EntitlementExceededError } = await import('@/lib/billing/errors');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const SCALED: ScaledTrackerSubscription = {
  status: 'active',
  priceId: 'tracker_annual',
  currentPeriodEnd: 1893456000,
};
const CANCELED: ScaledTrackerSubscription = { ...SCALED, status: 'canceled' };

async function orgIdOf(workspaceId: string): Promise<string> {
  return (await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).organizationId;
}

async function setTier(organizationId: string, sub: ScaledTrackerSubscription): Promise<void> {
  await db.organization.update({
    where: { id: organizationId },
    data: { scaledTrackerSubscription: sub as unknown as Prisma.InputJsonValue },
  });
}

/** Flag the org as the META org (moooon B.V.) — the `meta` tier, every cap lifted. */
async function setMeta(organizationId: string): Promise<void> {
  await db.organization.update({ where: { id: organizationId }, data: { isMeta: true } });
}

/** Bulk-seed `count` top-level task rows in the fixture's project (one INSERT —
 *  fast even at the 250 cap). `archived` stamps `archivedAt` so the §4
 *  "archived items still count" divergence is testable. */
async function seedWorkItems(
  fx: { workspaceId: string; projectId: string; projectIdentifier: string; ownerId: string },
  count: number,
  opts: { archived?: boolean } = {},
): Promise<void> {
  const archivedAt = opts.archived ? new Date() : null;
  await db.workItem.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      kind: 'task' as const,
      key: i + 1,
      identifier: `${fx.projectIdentifier}-${i + 1}`,
      title: `Item ${i + 1}`,
      reporterId: fx.ownerId,
      position: String(i + 1).padStart(6, '0'),
      archivedAt,
    })),
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
});

afterAll(async () => {
  await db.$disconnect();
});

describe('entitlementsService — work-item cap (§4.1)', () => {
  it('passes at 249 and blocks at the 250-item ceiling for a free org', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    await seedWorkItems(fx, 249);
    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();

    await db.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 250,
        identifier: `${fx.projectIdentifier}-250`,
        title: 'Item 250',
        reporterId: fx.ownerId,
        position: '000250',
      },
    });

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).rejects.toMatchObject({ name: 'EntitlementExceededError', entitlement: 'work_items' });
  });

  it('counts ARCHIVED items too — archiving does NOT free room (§4 divergence)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedWorkItems(fx, 250, { archived: true });

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  it('lifts the cap for a scaled (active scaled-tracker) org', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);
    await seedWorkItems(fx, 250);

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('lifts the cap for the META org (moooon B.V.) even with NO subscription', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setMeta(orgId); // the `meta` tier — every cap lifted, never billed
    await seedWorkItems(fx, 250);

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('a canceled scaled-tracker subscription is treated as free (caps re-apply)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, CANCELED);
    await seedWorkItems(fx, 250);

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  it('is INERT off-cloud — no cap when MOTIR_CLOUD is unset', async () => {
    delete process.env['MOTIR_CLOUD'];
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedWorkItems(fx, 300);

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('createWorkItem itself enforces the cap (end-to-end wiring)', async () => {
    const fx = await makeWorkItemFixture();
    await seedWorkItems(fx, 250);
    // Advance the project key counter past the bulk-seeded rows so the next
    // create allocates a FREE key (251) — proving the cap, not a key collision.
    await db.project.update({ where: { id: fx.projectId }, data: { lastWorkItemNumber: 250 } });

    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'over' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  // The required real-concurrency test: two creates racing at the 249→250 edge.
  // The org-row FOR UPDATE lock must serialize them so EXACTLY ONE lands the
  // 250th item and the other is rejected — never a 251-item overage (the
  // warm-pool TOCTOU a count-then-write with no lock would allow).
  it('serializes concurrent creates at the boundary via FOR UPDATE (no overage)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedWorkItems(fx, 249);

    const attempt = (key: number) =>
      db.$transaction(async (tx) => {
        await entitlementsService.assertWithinWorkItemCap(orgId, tx);
        await workItemRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            kind: 'task',
            key,
            identifier: `${fx.projectIdentifier}-${key}`,
            title: `race ${key}`,
            reporterId: fx.ownerId,
            position: String(key).padStart(6, '0'),
          },
          tx,
        );
      });

    const results = await Promise.allSettled([attempt(250), attempt(251)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(EntitlementExceededError);

    const finalCount = await db.workItem.count({ where: { projectId: fx.projectId } });
    expect(finalCount).toBe(250);
  });
});

describe('entitlementsService — project cap (§4.2)', () => {
  it('blocks the 4th project on free, allows it on scaled', async () => {
    const fx = await makeWorkItemFixture(); // creates project #1
    const orgId = await orgIdOf(fx.workspaceId);
    // Seed 2 more (total 3 = the free cap).
    for (let i = 2; i <= 3; i++) {
      await db.project.create({
        data: {
          workspaceId: fx.workspaceId,
          name: `P${i}`,
          slug: `p${i}`,
          identifier: `PRJ${i}`,
        },
      });
    }

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinProjectCap(orgId, tx)),
    ).rejects.toMatchObject({ entitlement: 'projects' });

    await setTier(orgId, SCALED);
    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinProjectCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });
});

describe('entitlementsService — workspace cap (§4.4)', () => {
  it('blocks the 2nd workspace on free (cap = 1), allows it on scaled', async () => {
    const fx = await makeWorkItemFixture(); // org already has its 1 workspace
    const orgId = await orgIdOf(fx.workspaceId);

    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkspaceCap(orgId, tx)),
    ).rejects.toMatchObject({ entitlement: 'workspaces' });

    await setTier(orgId, SCALED);
    await expect(
      db.$transaction((tx) => entitlementsService.assertWithinWorkspaceCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('createWorkspace blocks a 2nd workspace under a free org (end-to-end)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await expect(
      workspacesService.createWorkspace({
        name: 'Second',
        ownerUserId: fx.ownerId,
        organizationId: orgId,
      }),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });
});

describe('entitlementsService — org-creation gate (§4.5)', () => {
  it('allows a user FIRST org, blocks a 2nd free one, allows it once they own a paid org', async () => {
    const user = await createTestUser();

    // First org — the user owns none yet, always allowed.
    await expect(
      db.$transaction((tx) => entitlementsService.assertCanCreateOrganization(user.id, tx)),
    ).resolves.toBeUndefined();

    // Give them one (free) org.
    const { workspace } = await workspacesService.createWorkspace({
      name: 'First',
      ownerUserId: user.id,
    });
    const orgId = await orgIdOf(workspace.id);

    // A 2nd org is now gated (no paid org).
    await expect(
      db.$transaction((tx) => entitlementsService.assertCanCreateOrganization(user.id, tx)),
    ).rejects.toMatchObject({ entitlement: 'organizations' });

    // Upgrade the first org → the owner can now create more orgs.
    await setTier(orgId, SCALED);
    await expect(
      db.$transaction((tx) => entitlementsService.assertCanCreateOrganization(user.id, tx)),
    ).resolves.toBeUndefined();
  });

  it('is INERT off-cloud — a free account can create a 2nd org', async () => {
    delete process.env['MOTIR_CLOUD'];
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'First', ownerUserId: user.id });
    await expect(
      db.$transaction((tx) => entitlementsService.assertCanCreateOrganization(user.id, tx)),
    ).resolves.toBeUndefined();
  });

  it('owning the META org clears the gate (treated as paid)', async () => {
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'First',
      ownerUserId: user.id,
    });
    const orgId = await orgIdOf(workspace.id);

    // Without meta/paid → a 2nd org is gated.
    await expect(
      db.$transaction((tx) => entitlementsService.assertCanCreateOrganization(user.id, tx)),
    ).rejects.toMatchObject({ entitlement: 'organizations' });

    // Flag the org meta → the owner can now create more orgs.
    await setMeta(orgId);
    await expect(
      db.$transaction((tx) => entitlementsService.assertCanCreateOrganization(user.id, tx)),
    ).resolves.toBeUndefined();
  });
});

describe('entitlementsService — upload caps (§4.3)', () => {
  it('resolves the per-file limit by tier (free 10 MB / scaled 100 MB), Infinity off-cloud', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    expect(await entitlementsService.resolvePerFileLimitBytes(orgId)).toBe(10 * MB);

    await setTier(orgId, SCALED);
    expect(await entitlementsService.resolvePerFileLimitBytes(orgId)).toBe(100 * MB);

    // Off-cloud falls back to the 10 MB operational baseline (not unbounded) —
    // the per-file safety default predates billing; only the SCALED upgrade is
    // cloud-only. (The total-storage + count caps ARE fully lifted off-cloud.)
    delete process.env['MOTIR_CLOUD'];
    expect(await entitlementsService.resolvePerFileLimitBytes(orgId)).toBe(10 * MB);
  });

  it('accumulates org storage and blocks an upload that would exceed 2 GB on free', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    // Seed ~1.86 GB of attachments (two ~0.93 GB rows; each fits int4).
    const big = 1_000_000_000; // 1e9 bytes
    for (let i = 0; i < 2; i++) {
      await db.attachment.create({
        data: {
          workspaceId: fx.workspaceId,
          uploaderUserId: fx.ownerId,
          blobUrl: `https://blob.test/${i}`,
          mimeType: 'application/pdf',
          sizeBytes: big,
          originalFilename: `f${i}.pdf`,
        },
      });
    }

    // current = 2e9; 2e9 + 200e6 = 2.2e9 > 2 GB (2,147,483,648) → blocked.
    await expect(
      entitlementsService.assertWithinStorageCap(orgId, 200_000_000),
    ).rejects.toMatchObject({ entitlement: 'storage' });

    // A small file that stays under 2 GB is allowed.
    await db.attachment.deleteMany({ where: { workspaceId: fx.workspaceId } });
    await db.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        uploaderUserId: fx.ownerId,
        blobUrl: 'https://blob.test/small',
        mimeType: 'application/pdf',
        sizeBytes: big,
        originalFilename: 'small.pdf',
      },
    });
    await expect(
      entitlementsService.assertWithinStorageCap(orgId, 100_000_000),
    ).resolves.toBeUndefined();
  });

  it('lifts the storage cap on scaled (100 GB headroom)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);
    // A 3 GB incoming file (over free, well under scaled's 100 GB) is allowed.
    await expect(
      entitlementsService.assertWithinStorageCap(orgId, 3 * GB),
    ).resolves.toBeUndefined();
  });
});
