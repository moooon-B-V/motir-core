import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { createTestWorkspace } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { describeInFlight, inFlightBackends } from './helpers/inFlightWork';

// MOTIR-3077 — the sweep half of MOTIR-3066, at the one site the sweep found.
//
// `acceptanceVideoEligibilityService.resolve` fans out two arms, and arm 1 is an
// ACCESS GATE: `organizationsService.resolveOrgAccess` runs `assertOrgMember`,
// which throws `OrganizationNotFoundError` for an actor who is not a member of
// the organization behind the workspace — the 404-not-403 rule, and an ORDINARY
// path, not a fault. Arm 0 is a `withOrgContext` interactive transaction.
//
// Under `Promise.all` the refusal returned the instant arm 1 threw and left arm
// 0 running with nobody awaiting it: an open transaction holding a pool
// connection and `AccessShareLock`s after the caller believed the read was over.
// That is `getQuickView`'s shape exactly, with the gate written second. In the
// suite the next test's `TRUNCATE … CASCADE` walks into those locks in a
// different order and deadlocks (`40P01`); in production nothing reports it at
// all.
//
// This file asserts the invariant the reset depends on, in the shape of
// `tests/work-items/quick-view-refused-peek.test.ts`: a REFUSED resolve must
// leave nothing running.

const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));

vi.mock('@/lib/services/billingService', () => ({
  billingService: {
    getAiAccessForContext: vi.fn(async () => aiAccess.current),
  },
}));

const { acceptanceVideoEligibilityService } =
  await import('@/lib/services/acceptanceVideoEligibilityService');
const { organizationsService } = await import('@/lib/services/organizationsService');

function access(partial: Partial<AiAccessDTO>): AiAccessDTO {
  return {
    applicable: true,
    organizationId: null,
    organizationName: 'Acme',
    canManageBilling: false,
    hasPaidAiPlan: false,
    balance: 0,
    tierName: null,
    tierAllotment: null,
    renewsAt: null,
    ...partial,
  };
}

async function seed(name: string) {
  const { workspace, owner } = await createTestWorkspace({ name });
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { workspaceId: workspace.id, ownerId: owner.id, organizationId: ws.organizationId };
}

beforeEach(async () => {
  aiAccess.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a REFUSED eligibility resolve leaves no work in flight (MOTIR-3077)', () => {
  it('a foreign organization rejects AND abandons no transaction', async () => {
    const home = await seed('Elig Home');
    const foreign = await seed('Elig Foreign');

    // The actor belongs to `home`; the org resolved for the read is `foreign`'s.
    // `assertOrgMember` therefore refuses — the ordinary cross-tenant 404 path.
    aiAccess.current = access({ organizationId: foreign.organizationId, hasPaidAiPlan: true });

    await expect(
      acceptanceVideoEligibilityService.resolve({
        actorUserId: home.ownerId,
        workspaceId: home.workspaceId,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);

    // …and the moment it does, nothing this worker started may still be running.
    const leftover = await inFlightBackends();
    expect(
      leftover,
      `a refused resolve left ${leftover.length} backend(s) in flight:\n${describeInFlight(leftover)}`,
    ).toEqual([]);
  });

  it('a gate that refuses IMMEDIATELY still abandons nothing', async () => {
    // The case above drives the REAL refusal and passes either way, and that is
    // worth stating rather than hiding: both arms are two-statement round trips,
    // so the abandoned read finishes inside the time `inFlightBackends()` itself
    // takes, and the assertion cannot see the window. Measured, not assumed —
    // with the repair reverted to `Promise.all` it is green 3/3.
    //
    // So this case removes the timing accident instead of relying on it. The
    // gate rejects on the first microtask while the sibling's transaction is
    // provably still open, which is the class the repair is FOR: whether the
    // caller waits does not depend on which arm happens to be slower. It fails
    // on `Promise.all` and passes on `allSettledOrThrow`.
    const fx = await seed('Elig Immediate');
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    const spy = vi
      .spyOn(organizationsService, 'resolveOrgAccess')
      .mockRejectedValue(new OrganizationNotFoundError(fx.organizationId));

    try {
      await expect(
        acceptanceVideoEligibilityService.resolve({
          actorUserId: fx.ownerId,
          workspaceId: fx.workspaceId,
        }),
      ).rejects.toBeInstanceOf(OrganizationNotFoundError);

      const leftover = await inFlightBackends();
      expect(
        leftover,
        `a refused resolve left ${leftover.length} backend(s) in flight:\n${describeInFlight(leftover)}`,
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('an ACCEPTED resolve still returns the whole verdict', async () => {
    // The repair must not change the happy path: both arms still run
    // concurrently and every field still arrives.
    const fx = await seed('Elig Accepted');
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });

    expect(r).toMatchObject({
      applicable: true,
      eligible: true,
      hasPaidAiPlan: true,
      organizationId: fx.organizationId,
    });
    expect(await inFlightBackends()).toEqual([]);
  });
});
