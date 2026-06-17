import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawUsageResponse } from '@/lib/ai/types';

// The motir-ai boundary client is an external HTTP leaf — mock it (the one
// legitimate boundary mock, like a network call) and seed the rest (org /
// workspace / project / membership) through the real services against the real
// Postgres (the no-mocks rule otherwise). This proves the read-through service's
// GATE + server-side scope decision + name enrichment, independent of motir-ai.
const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
}));

const { aiUsageService } = await import('@/lib/services/aiUsageService');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { OrganizationNotFoundError } = await import('@/lib/organizations/errors');
const { truncateAuthTables } = await import('./helpers/db');

function rawResponse(over: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    scope: 'org',
    coreOrganizationId: 'o',
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: 12480,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20000 },
    totalSpend: 147520,
    monthSpend: 7520,
    monthlyHistory: [
      { yearMonth: '2026-05', credits: 6400 },
      { yearMonth: '2026-06', credits: 7520 },
    ],
    perModel: [{ model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 200, credits: 5180 }],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    ...over,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('aiUsageService.getUsage', () => {
  it('gives an org admin the full org scope + drill workspaces + enriched run names', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    getOrgUsageMock.mockResolvedValue(
      rawResponse({
        recentRuns: {
          runs: [
            {
              jobId: 'job_1',
              jobKind: 'generate_tree',
              model: 'claude-opus-4-8',
              coreWorkspaceId: workspace.id,
              coreProjectId: project.id,
              inputTokens: 1000,
              outputTokens: 200,
              credits: 86,
              startedAt: '2026-06-16T14:22:00.000Z',
            },
          ],
          page: 1,
          pageSize: 10,
          total: 1,
        },
      }),
    );

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.access.isAdmin).toBe(true);
    expect(res.scope).toBe('org');
    expect(res.drill.workspaces.map((w) => w.id)).toContain(workspace.id);
    expect(res.balance).toBe(12480);
    expect(res.hasUsage).toBe(true);
    // The run's project id was enriched with the motir-core project NAME.
    expect(res.recentRuns.runs[0]?.projectName).toBe(project.name);
    // The org admin's call to motir-ai used the org scope.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'org', coreOrganizationId: workspace.organizationId }),
    );
  });

  it('narrows a non-admin member to their own project scope server-side', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const member = await createTestUser();
    // Joining the workspace auto-enrols the user in its org (the upward invariant).
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    getOrgUsageMock.mockResolvedValue(
      rawResponse({ scope: 'project', coreProjectId: project.id, coreWorkspaceId: workspace.id }),
    );

    // The member ASKS for the org scope; the service must refuse and narrow.
    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: member.id,
      scope: 'org',
    });

    expect(res.access.isAdmin).toBe(false);
    expect(res.scope).toBe('project');
    expect(res.activeProject?.id).toBe(project.id);
    expect(res.drill.workspaces).toHaveLength(0); // no cross-workspace drill for a member
    // motir-ai was asked for the member's PROJECT slice, never the org.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', coreProjectId: project.id }),
    );
  });

  it('404s (OrganizationNotFoundError) a non-member of the org, with no motir-ai call', async () => {
    const { workspace } = await createTestWorkspace();
    const outsider = await createTestUser();

    await expect(
      aiUsageService.getUsage({
        organizationId: workspace.organizationId,
        actorUserId: outsider.id,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
    expect(getOrgUsageMock).not.toHaveBeenCalled();
  });
});
