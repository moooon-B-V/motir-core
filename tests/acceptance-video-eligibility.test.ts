import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { createTestWorkspace } from './fixtures';
import { truncateAuthTables } from './helpers/db';

// acceptanceVideoEligibilityService + organizationsService.setAcceptanceVideoEnabled
// (Story MOTIR-1627 · Subtask MOTIR-1630) against a REAL Postgres. billingService
// is mocked at the getAiAccessForContext seam ONLY (its own tests cover the plan
// resolution) so this suite proves the COMBINATION logic — plan × toggle — and
// the real org-admin-gated toggle write.

const aiAccess = vi.hoisted(() => ({
  current: null as AiAccessDTO | null,
}));

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

async function seed() {
  const { workspace, owner } = await createTestWorkspace({ name: 'Elig WS' });
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { workspaceId: workspace.id, ownerId: owner.id, organizationId: ws.organizationId };
}

beforeEach(async () => {
  aiAccess.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('acceptanceVideoEligibilityService.resolve', () => {
  it('paid plan + toggle ON → eligible', async () => {
    const fx = await seed();
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    expect(r).toMatchObject({
      applicable: true,
      eligible: true,
      reason: 'eligible',
      hasPaidAiPlan: true,
      toggleEnabled: true, // default ON
      canManageToggle: true, // the owner
    });
  });

  it('paid plan + toggle OFF → not eligible, reason toggle_off', async () => {
    const fx = await seed();
    await organizationsService.setAcceptanceVideoEnabled({
      organizationId: fx.organizationId,
      actorUserId: fx.ownerId,
      enabled: false,
    });
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('toggle_off');
    expect(r.toggleEnabled).toBe(false);
  });

  it('no paid plan → not eligible, reason no_plan (toggle irrelevant)', async () => {
    const fx = await seed();
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: false });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('no_plan');
  });

  it('not applicable (self-host / meta) → UNGATED, so eligible with reason not_applicable', async () => {
    const fx = await seed();
    aiAccess.current = access({ applicable: false, organizationId: null });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    // Self-host / meta org has no plan to buy + no storage to meter → the feature
    // just works (the moooon self-test dogfood depends on this).
    expect(r).toMatchObject({
      applicable: false,
      eligible: true,
      reason: 'not_applicable',
      organizationId: null,
    });
  });
});

describe('organizationsService.setAcceptanceVideoEnabled', () => {
  it('an org owner flips the toggle; the DTO + row reflect it', async () => {
    const fx = await seed();

    const dto = await organizationsService.setAcceptanceVideoEnabled({
      organizationId: fx.organizationId,
      actorUserId: fx.ownerId,
      enabled: false,
    });
    expect(dto.acceptanceVideoEnabled).toBe(false);

    const row = await db.organization.findUniqueOrThrow({ where: { id: fx.organizationId } });
    expect(row.acceptanceVideoEnabled).toBe(false);
  });

  it('a non-member cannot flip it (404 no-leak)', async () => {
    const fx = await seed();
    const { owner: stranger } = await createTestWorkspace({ name: 'Other' });

    await expect(
      organizationsService.setAcceptanceVideoEnabled({
        organizationId: fx.organizationId,
        actorUserId: stranger.id,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
  });
});
