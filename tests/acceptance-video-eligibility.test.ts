import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { createTestWorkspace } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// acceptanceVideoEligibilityService + organizationsService.setAcceptanceVideoEnabled
// (Story MOTIR-1627 · Subtask MOTIR-1630) against a REAL Postgres. billingService
// is mocked at the getAiAccessForContext seam ONLY (its own tests cover the plan
// resolution) so this suite proves the COMBINATION logic — plan × switch — and
// the real org-admin-gated toggle write.
//
// ⚠️ THE TWO HALVES OF THE AND NOW LIVE AT DIFFERENT TIERS (MOTIR-4925 ·
// MOTIR-5168): `hasPaidAiPlan` is the ORGANISATION's and the SWITCH is the
// PROJECT's. So the toggle_off case flips a PROJECT, and the suite carries a pair
// of projects under ONE organisation that disagree — the only fixture shape that
// can tell a per-project read from a per-organisation one, because with a single
// project both answers are identical.

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

let projectSeq = 0;

/** A project in this workspace, with its gate switch set. */
async function addProject(workspaceId: string, enabled = true) {
  const n = projectSeq++;
  return adminDb.project.create({
    data: {
      name: `Elig P${n}`,
      slug: `elig-p-${n}`,
      identifier: `EL${n}`,
      workspaceId,
      acceptanceVideoEnabled: enabled,
    },
  });
}

async function seed() {
  const { workspace, owner } = await createTestWorkspace({ name: 'Elig WS' });
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  const project = await addProject(workspace.id);
  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    organizationId: ws.organizationId,
    projectId: project.id,
  };
}

beforeEach(async () => {
  aiAccess.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('acceptanceVideoEligibilityService.resolve', () => {
  it('paid plan + toggle ON → eligible', async () => {
    const fx = await seed();
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
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

  it('paid plan + the PROJECT switch OFF → not eligible, reason toggle_off', async () => {
    const fx = await seed();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { acceptanceVideoEnabled: false },
    });
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
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
      projectId: fx.projectId,
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
      projectId: fx.projectId,
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

describe("the switch is the PROJECT's, and the entitlement stays the organisation's", () => {
  it('two projects in ONE organisation resolve DIFFERENTLY — the pair', async () => {
    const fx = await seed();
    const off = await addProject(fx.workspaceId, false);
    const on = await addProject(fx.workspaceId, true);
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    // The organisation's own column is left ON for both, so neither verdict can
    // be right by accident: a read that still consulted the organisation would
    // return `eligible` for the OFF project too.
    const orgRow = await adminDb.organization.findUniqueOrThrow({
      where: { id: fx.organizationId },
    });
    expect(orgRow.acceptanceVideoEnabled).toBe(true);

    const offVerdict = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: off.id,
    });
    const onVerdict = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: on.id,
    });

    expect(offVerdict).toMatchObject({
      eligible: false,
      reason: 'toggle_off',
      toggleEnabled: false,
    });
    expect(onVerdict).toMatchObject({ eligible: true, reason: 'eligible', toggleEnabled: true });
  });

  it('a flip in one project changes NOTHING in its sibling', async () => {
    const fx = await seed();
    const a = await addProject(fx.workspaceId, true);
    const b = await addProject(fx.workspaceId, true);
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    await adminDb.project.update({ where: { id: a.id }, data: { acceptanceVideoEnabled: false } });

    const verdictA = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: a.id,
    });
    const verdictB = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: b.id,
    });

    expect(verdictA.toggleEnabled).toBe(false);
    expect(verdictB.toggleEnabled, 'the sibling project keeps its own answer').toBe(true);
  });

  it('the ORGANISATION flag no longer moves the verdict — only the entitlement does', async () => {
    // The migration's whole point, asserted from the losing side. Flipping the org
    // column OFF while the project stays ON must not gate the project; the org's
    // remaining job is `hasPaidAiPlan`, which is mocked here and is what DOES gate.
    const fx = await seed();
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: true });

    await organizationsService.setAcceptanceVideoEnabled({
      organizationId: fx.organizationId,
      actorUserId: fx.ownerId,
      enabled: false,
    });

    const r = await acceptanceVideoEligibilityService.resolve({
      actorUserId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(r.toggleEnabled, 'the project said ON; the organisation is not asked').toBe(true);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe('eligible');
  });

  it('the entitlement is still ORG-resolved: no paid plan gates every project', async () => {
    const fx = await seed();
    const other = await addProject(fx.workspaceId, true);
    aiAccess.current = access({ organizationId: fx.organizationId, hasPaidAiPlan: false });

    for (const projectId of [fx.projectId, other.id]) {
      const r = await acceptanceVideoEligibilityService.resolve({
        actorUserId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId,
      });
      expect(r.eligible).toBe(false);
      expect(r.reason).toBe('no_plan');
    }
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

    const row = await adminDb.organization.findUniqueOrThrow({ where: { id: fx.organizationId } });
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
