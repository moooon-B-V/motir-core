import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { billingPropagationService } from '@/lib/services/billingPropagationService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Service test for billingPropagationService.setScaledTrackerState (Subtask
// 8.1.4c) — the motir-core consumer side of scaled-tracker subscription
// propagation. Real Postgres, no mocks. Proves: the column round-trips, the
// clear path resets to NULL, repeats are idempotent, an unknown org → typed
// 404, AND the RLS contract the service relies on (the org-GUC-only write is
// admitted under the non-bypass prodect_app role, and the GUC is load-bearing).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const STATE: ScaledTrackerSubscription = {
  status: 'active',
  priceId: 'tracker_monthly',
  currentPeriodEnd: 1893456000,
};

// Mint an org by founding a workspace (createWorkspace auto-provisions the org +
// owner membership), and return its org id.
async function makeOrg(): Promise<string> {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  return (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).organizationId;
}

// Read the raw column back. The default test role is BYPASSRLS, so this sees the
// row regardless of context — it's the ground-truth assertion of what persisted.
async function readColumn(orgId: string): Promise<unknown> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  return org.scaledTrackerSubscription;
}

describe('billingPropagationService.setScaledTrackerState', () => {
  it('persists the subscription state and returns the confirmation DTO', async () => {
    const orgId = await makeOrg();

    const dto = await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: STATE,
    });

    expect(dto).toEqual({ organizationId: orgId, scaledTrackerSubscription: STATE });
    expect(await readColumn(orgId)).toEqual(STATE);
  });

  it('is idempotent — re-applying the same state re-writes the same value', async () => {
    const orgId = await makeOrg();

    const first = await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: STATE,
    });
    const second = await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: STATE,
    });

    expect(second).toEqual(first);
    expect(await readColumn(orgId)).toEqual(STATE);
  });

  it('updates an existing state in place (e.g. active → past_due)', async () => {
    const orgId = await makeOrg();
    await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: STATE,
    });

    const next: ScaledTrackerSubscription = { ...STATE, status: 'past_due' };
    const dto = await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: next,
    });

    expect(dto.scaledTrackerSubscription).toEqual(next);
    expect(await readColumn(orgId)).toEqual(next);
  });

  it('clears the column to NULL when given null (the cancel path — non-destructive)', async () => {
    const orgId = await makeOrg();
    await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: STATE,
    });

    const dto = await billingPropagationService.setScaledTrackerState({
      organizationId: orgId,
      scaledTrackerSubscription: null,
    });

    expect(dto).toEqual({ organizationId: orgId, scaledTrackerSubscription: null });
    // SQL NULL, not the JSON `null` literal.
    expect(await readColumn(orgId)).toBeNull();
  });

  it('throws OrganizationNotFoundError for an unknown org id', async () => {
    await expect(
      billingPropagationService.setScaledTrackerState({
        organizationId: 'org_does_not_exist',
        scaledTrackerSubscription: STATE,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });
});

// The RLS contract the service leans on: the org UPDATE policy gates purely on
// app.organization_id (no user). These run as the non-bypass prodect_app role to
// actually exercise the policy (the superuser default would bypass it).
describe('scaled-tracker write under RLS (prodect_app role)', () => {
  async function asAppRole<T>(
    organizationId: string | undefined,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      if (organizationId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      }
      await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
      return fn(tx);
    });
  }

  it('admits the UPDATE when the active-org GUC matches the target org (no user bound)', async () => {
    const orgId = await makeOrg();

    const updated = await asAppRole(orgId, (tx) =>
      organizationRepository.updateScaledTrackerState(orgId, STATE, tx),
    );

    expect(updated.scaledTrackerSubscription).toEqual(STATE);
    expect(await readColumn(orgId)).toEqual(STATE);
  });

  it('the org GUC is load-bearing — without it the UPDATE finds no row (P2025)', async () => {
    const orgId = await makeOrg();

    await expect(
      asAppRole(undefined, (tx) =>
        organizationRepository.updateScaledTrackerState(orgId, STATE, tx),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
  });
});
