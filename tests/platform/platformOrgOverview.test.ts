import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError, PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import type {
  RawPlatformRunsPage,
  RawPlatformUsage,
  RawPlatformUsageChildren,
  RawSpendRow,
} from '@/lib/ai/motirAiClient';

/**
 * The org page's Overview (Story MOTIR-727 · MOTIR-733, design D5) —
 * `platformOrgPageService.getOverview` over the real database, motir-ai faked at
 * the client: one audit row naming the org, members keyset, workspaces with this
 * month's credits, jobs, and every motir-ai region's unavailable state.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const usageMock = vi.fn<(q: unknown) => Promise<RawPlatformUsage>>();
const childrenMock = vi.fn<(q: unknown) => Promise<RawPlatformUsageChildren>>();
const runsMock = vi.fn<(q: unknown) => Promise<RawPlatformRunsPage>>();
const orgUsageMock = vi.fn<(q: unknown) => Promise<{ balance: number }>>();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return {
    ...actual,
    getPlatformUsage: (q: unknown) => usageMock(q),
    getPlatformUsageChildren: (q: unknown) => childrenMock(q),
    getPlatformRuns: (q: unknown) => runsMock(q),
    getOrgUsage: (q: unknown) => orgUsageMock(q),
  };
});

const { db } = await import('@/lib/db');
const { platformOrgPageService, ORG_MEMBERS_PAGE } =
  await import('@/lib/services/platformOrgPageService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-10-02T12:00:00Z');

function row(entityId: string, chargedCredits: number): RawSpendRow {
  const zero = {
    planning_tokens: 0,
    agent_tokens: 0,
    agent_machine: 0,
    agent_instance: 0,
    agent_storage: 0,
    ci: 0,
    search: 0,
  };
  return {
    entityId,
    credits: zero,
    indexingSeconds: 0,
    chargedCredits,
    costMicroUsd: 0,
    cost: { ...zero, indexing: 0 },
  };
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+orgpage@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  usageMock.mockReset();
  childrenMock.mockReset();
  runsMock.mockReset();
  orgUsageMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformOrgPageService.getOverview', () => {
  it('reads this month, the workspaces’ credits and the jobs, under ONE estate.read naming the org', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Engineering' });
    const orgId = workspace.organizationId;
    usageMock.mockResolvedValue({
      period: '2026-10',
      level: 'organization',
      entityId: orgId,
      categories: [],
      models: { planning_tokens: [], agent_tokens: [] },
      spend: {
        chargedCredits: 0,
        chargedCostMicroUsd: 0,
        costMicroUsdInclIndexing: 0,
        machineSeconds: 0,
      },
      orgsWithSpend: null,
    });
    childrenMock.mockResolvedValue({
      period: '2026-10',
      sort: 'charged',
      level: 'organization',
      entityId: orgId,
      childLevel: 'workspace',
      items: [row(workspace.id, 420)],
      nextCursor: null,
      remainder: null,
    });
    runsMock.mockResolvedValue({
      items: [
        {
          kind: 'coding',
          id: 'r1',
          ref: 'run_1',
          coreOrganizationId: orgId,
          coreWorkspaceId: workspace.id,
          coreProjectId: null,
          model: 'claude-opus-5-5',
          status: null,
          startedAt: '2026-10-01T10:00:00.000Z',
          lastActivityAt: '2026-10-01T10:30:00.000Z',
          inputTokens: 1,
          outputTokens: 1,
          credits: 9,
        },
      ],
      nextCursor: 'older',
      codingRunsUnattributedExcluded: false,
    });

    const o = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(usageMock).toHaveBeenCalledWith({
      period: '2026-10',
      level: 'organization',
      entityId: orgId,
    });
    expect(o.month).toBe('2026-10');
    expect(o.monthCategories).toEqual([]);
    expect(o.workspaces).toEqual([
      expect.objectContaining({ id: workspace.id, name: 'Engineering', monthChargedCredits: 420 }),
    ]);
    expect(o.jobs.items[0]).toMatchObject({
      kind: 'coding_run',
      workspace: { name: 'Engineering' },
      credits: 9,
    });
    expect(o.jobs.nextCursor).toBe('older');
    expect(o.members.total).toBe(1);

    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: orgId,
    });
  });

  it('pages the members on a keyset — every member once', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Big' });
    const orgId = workspace.organizationId;
    for (let i = 0; i < ORG_MEMBERS_PAGE + 4; i += 1) {
      const u = await createTestUser({ email: `member-${i}@example.com` });
      await adminDb.organizationMembership.create({
        data: { organizationId: orgId, userId: u.id, role: 'member' },
      });
    }
    usageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));

    const first = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(first.members.items).toHaveLength(ORG_MEMBERS_PAGE);
    expect(first.members.total).toBe(ORG_MEMBERS_PAGE + 5);
    const second = await platformOrgPageService.getOverview(currentPrincipal!, orgId, {
      now: NOW,
      membersCursor: first.members.nextCursor,
    });
    expect(second.members.nextCursor).toBeNull();
    const ids = [...first.members.items, ...second.members.items].map((m) => m.userId);
    expect(new Set(ids).size).toBe(ORG_MEMBERS_PAGE + 5);
    expect(ids).toContain(owner.id);
    expect(first.members.items[0]).toMatchObject({ role: 'owner' });
  });

  it('motir-ai unreachable: every remote region says so, the motir-core half renders, one audit row', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Solo' });
    usageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    const o = await platformOrgPageService.getOverview(
      currentPrincipal!,
      workspace.organizationId,
      { now: NOW },
    );
    expect(o.monthCategories).toBeNull();
    expect(o.workspaceSpendUnavailable).toBe(true);
    expect(o.workspaces[0]).toMatchObject({ name: 'Solo', monthChargedCredits: null });
    expect(o.jobs).toEqual({ items: [], nextCursor: null, unavailable: true });
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('a workspace missing from a CUT-OFF children list reads as unknown, not zero', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Quiet' });
    const orgId = workspace.organizationId;
    usageMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    childrenMock.mockResolvedValue({
      period: '2026-10',
      sort: 'charged',
      level: 'organization',
      entityId: orgId,
      childLevel: 'workspace',
      items: [row('other_ws', 5)],
      nextCursor: 'more',
      remainder: null,
    });
    const cut = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(cut.workspaces[0]!.monthChargedCredits).toBeNull();

    childrenMock.mockResolvedValue({
      ...(await childrenMock.mock.results[0]!.value),
      nextCursor: null,
    });
    const whole = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(whole.workspaces[0]!.monthChargedCredits).toBe(0);
  });

  it('an unknown org throws inside the read and leaves no audit row', async () => {
    usageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    await expect(
      platformOrgPageService.getOverview(currentPrincipal!, 'org_nope'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('refuses a non-staff caller before reading', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(platformOrgPageService.getOverview(principal, 'org_x')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(usageMock).not.toHaveBeenCalled();
  });
});

describe('platformOrgPageService.getUsageTab', () => {
  const usage: RawPlatformUsage = {
    period: 'all',
    level: 'organization',
    entityId: 'x',
    categories: [],
    models: { planning_tokens: [], agent_tokens: [] },
    spend: {
      chargedCredits: 0,
      chargedCostMicroUsd: 0,
      costMicroUsdInclIndexing: 0,
      machineSeconds: 0,
    },
    orgsWithSpend: null,
  };

  it('reads the chosen scope — org, workspace or project — each under ONE audit row naming it', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Eng' });
    const orgId = workspace.organizationId;
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Mobile',
      identifier: 'MOB',
    });
    usageMock.mockResolvedValue(usage);
    orgUsageMock.mockResolvedValue({ balance: 1234 });

    const org = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: 'all',
    });
    expect(org.scope).toEqual({ level: 'organization' });
    expect(usageMock).toHaveBeenLastCalledWith({
      period: 'all',
      level: 'organization',
      entityId: orgId,
    });
    expect(org.balance).toBe(1234);
    expect(org.scopes).toEqual([
      { id: workspace.id, name: 'Eng', projects: [{ id: project.id, name: 'Mobile' }] },
    ]);

    const ws = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: '2026-09',
      scope: `workspace:${workspace.id}`,
    });
    expect(ws.scope).toEqual({ level: 'workspace', id: workspace.id, name: 'Eng' });
    expect(usageMock).toHaveBeenLastCalledWith({
      period: '2026-09',
      level: 'workspace',
      entityId: workspace.id,
    });

    const pj = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: '2026-09',
      scope: `project:${project.id}`,
    });
    expect(pj.scope).toMatchObject({
      level: 'project',
      id: project.id,
      workspace: { id: workspace.id },
    });

    const audit = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.targetLabel)).toEqual([
      'usage organization all',
      `usage workspace:${workspace.id} 2026-09`,
      `usage project:${project.id} 2026-09`,
    ]);
    expect(audit.every((a) => a.targetId === orgId && a.action === 'estate.read')).toBe(true);
  });

  it('a workspace of ANOTHER org is never read under this org — it falls back to the org scope', async () => {
    const mine = await createTestWorkspace({ name: 'Mine' });
    const theirs = await createTestWorkspace({ name: 'Theirs' });
    usageMock.mockResolvedValue(usage);
    orgUsageMock.mockResolvedValue({ balance: 0 });
    const tab = await platformOrgPageService.getUsageTab(
      currentPrincipal!,
      mine.workspace.organizationId,
      {
        period: 'all',
        scope: `workspace:${theirs.workspace.id}`,
      },
    );
    expect(tab.scope).toEqual({ level: 'organization' });
    for (const call of usageMock.mock.calls) {
      expect((call[0] as { entityId: string }).entityId).not.toBe(theirs.workspace.id);
    }
  });

  it('motir-ai unreachable: usage and balance are null, the org still renders, one audit row', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Solo' });
    usageMock.mockRejectedValue(new Error('down'));
    orgUsageMock.mockRejectedValue(new Error('down'));
    const tab = await platformOrgPageService.getUsageTab(
      currentPrincipal!,
      workspace.organizationId,
      { period: 'all' },
    );
    expect(tab).toMatchObject({ usage: null, balance: null });
    expect(tab.organization.id).toBe(workspace.organizationId);
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('an unknown org throws inside the read — no audit row, no motir-ai call', async () => {
    await expect(
      platformOrgPageService.getUsageTab(currentPrincipal!, 'org_nope', { period: 'all' }),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(usageMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});
