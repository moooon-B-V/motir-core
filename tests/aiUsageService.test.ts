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
    expect(res.isMeta).toBe(false);
    // The org admin's call to motir-ai used the org scope.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'org', coreOrganizationId: workspace.organizationId }),
    );
  });

  it('flags the META org (moooon B.V.) so the dashboard shows the balance as Unlimited', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await db.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
    getOrgUsageMock.mockResolvedValue(rawResponse({}));

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.isMeta).toBe(true);
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

  // ── 7.2.12 lock-in: the admin drill-scope resolution branches ──
  // An admin can drill DOWN to a workspace / project, but the server validates
  // every requested id against the org (never trusts the query) and narrows up
  // when an id is unknown or foreign. These are the scope-decision branches the
  // happy-path org test above doesn't reach.

  it('honours an admin drilling to a workspace scope with a valid workspaceId', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(
      rawResponse({ scope: 'workspace', coreWorkspaceId: workspace.id }),
    );

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
      scope: 'workspace',
      workspaceId: workspace.id,
    });

    expect(res.scope).toBe('workspace');
    expect(res.activeWorkspace?.id).toBe(workspace.id);
    // The active workspace's projects are offered as the drill.
    expect(res.drill.projects.map((p) => p.id)).toContain(project.id);
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workspace', coreWorkspaceId: workspace.id }),
    );
  });

  it('honours an admin drilling to a project scope with a valid workspace + project', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(
      rawResponse({ scope: 'project', coreWorkspaceId: workspace.id, coreProjectId: project.id }),
    );

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
      scope: 'project',
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(res.scope).toBe('project');
    expect(res.activeProject?.id).toBe(project.id);
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', coreProjectId: project.id }),
    );
  });

  it('narrows an admin project scope UP to workspace when the projectId is unknown', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(
      rawResponse({ scope: 'workspace', coreWorkspaceId: workspace.id }),
    );

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
      scope: 'project',
      workspaceId: workspace.id,
      projectId: 'does-not-exist',
    });

    // A project that isn't in the active workspace narrows up, never leaks.
    expect(res.scope).toBe('workspace');
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workspace', coreProjectId: null }),
    );
  });

  it('falls an admin workspace scope BACK to org when the workspaceId is foreign', async () => {
    const { workspace, owner } = await createTestWorkspace();
    // A workspace in a DIFFERENT org — not in the actor's org, so unknown here.
    const { workspace: foreign } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse({ scope: 'org' }));

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
      scope: 'workspace',
      workspaceId: foreign.id,
    });

    expect(res.scope).toBe('org');
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'org', coreWorkspaceId: null }),
    );
  });

  it('renders the empty/limited state for a member with no accessible project — no motir-ai call', async () => {
    // A workspace with NO project; the member can reach the workspace but has no
    // project slice, so there is nothing to fetch.
    const { workspace } = await createTestWorkspace();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: member.id,
    });

    expect(res.access.isAdmin).toBe(false);
    expect(res.scope).toBe('project');
    expect(res.hasUsage).toBe(false);
    expect(res.balance).toBe(0);
    expect(res.activeProject).toBeNull();
    // Nothing to fetch → the boundary is never called (no misleading zero-cost
    // round-trip).
    expect(getOrgUsageMock).not.toHaveBeenCalled();
  });

  it('marks hasUsage from run count alone and tolerates an unresolved run project name', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(
      rawResponse({
        // No spend yet, but a run exists → hasUsage is driven by the run count.
        totalSpend: 0,
        monthSpend: 0,
        recentRuns: {
          runs: [
            {
              jobId: 'job_x',
              jobKind: 'generate_tree',
              model: 'claude-opus-4-8',
              // A workspace/project the actor can't resolve (e.g. since deleted)
              // → the name enrichment must fall back to '', never throw.
              coreWorkspaceId: 'ws_gone',
              coreProjectId: 'pj_gone',
              inputTokens: 10,
              outputTokens: 2,
              credits: 1,
              startedAt: '2026-06-16T00:00:00.000Z',
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

    expect(res.hasUsage).toBe(true); // total > 0 even though spend is 0
    expect(res.recentRuns.runs[0]?.projectName).toBe(''); // unresolved → '', not a throw
  });
});
