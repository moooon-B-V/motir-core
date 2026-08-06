import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawCodeAuditSurface } from '@/lib/ai/motirAiClient';

// The audit-COVERAGE read (MOTIR-2248) — "which connected repos have no derived
// audit". The motir-ai HTTP client is the one sanctioned boundary mock; the
// workspace / project / installation half is seeded through the real services
// against real Postgres.
const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: unknown) => getCodeAuditMock(q),
}));

const { auditCoverageService } = await import('@/lib/services/auditCoverageService');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { NotProjectAdminError } = await import('@/lib/projects/errors');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

// `listByInstallation` orders `owner asc, name asc`, so the coverage entries come
// back in this order and the fixtures can assert it.
const THREE_REPOS = [
  {
    providerRepoId: '401',
    owner: 'moooon',
    name: 'motir-ai',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '402',
    owner: 'moooon',
    name: 'motir-core',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '403',
    owner: 'moooon',
    name: 'motir-gateway',
    defaultBranch: 'master',
    archived: false,
  },
];

// motir-ai's REAL `GET /v1/code-audit` body. `audit: null` is a SUCCESSFUL read
// of a repo with nothing derived — the never-audited case, not a failure.
function auditedSurface(repoKey: string): RawCodeAuditSurface {
  return {
    audit: {
      id: `audit_${repoKey}`,
      aiProjectId: 'ai_1',
      healthSummary: { grade: 'B', conformancePct: 78 },
      codeGraphRef: null,
      repoKey,
      jobId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total: 12,
    nextOffset: null,
  };
}

function neverAuditedSurface(): RawCodeAuditSurface {
  return { audit: null, findings: [], total: 0, nextOffset: null };
}

async function projectWithThreeRepos(installationId: string) {
  const { workspace, owner } = await createTestWorkspace();
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: THREE_REPOS,
  });
  return { workspace, owner, project };
}

beforeEach(async () => {
  await truncateAuthTables();
  getCodeAuditMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('auditCoverageService.getCoverage', () => {
  it('reports one entry per connected repo and counts the un-audited ones', async () => {
    const { workspace, owner, project } = await projectWithThreeRepos('inst-cov-mixed');
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      // motir-core is audited; the other two never were.
      return Promise.resolve(
        repoKey === 'moooon/motir-core' ? auditedSurface(repoKey) : neverAuditedSurface(),
      );
    });

    const coverage = await auditCoverageService.getCoverage(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(coverage).toEqual({
      repos: [
        { repoKey: 'moooon/motir-ai', state: 'not_audited' },
        { repoKey: 'moooon/motir-core', state: 'audited' },
        { repoKey: 'moooon/motir-gateway', state: 'not_audited' },
      ],
      notAuditedCount: 2,
    });
  });

  it('returns a well-formed EMPTY answer for a project with no connected repo', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    const coverage = await auditCoverageService.getCoverage(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(coverage).toEqual({ repos: [], notAuditedCount: 0 });
    // Nothing crossed the boundary at all — there was nothing to ask about.
    expect(getCodeAuditMock).not.toHaveBeenCalled();
  });

  it('degrades ONE failing repo without dropping its siblings, and does NOT count it', async () => {
    const { workspace, owner, project } = await projectWithThreeRepos('inst-cov-one-fails');
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      if (repoKey === 'moooon/motir-core')
        return Promise.reject(new MotirAiUnavailableError('down'));
      if (repoKey === 'moooon/motir-ai') return Promise.resolve(auditedSurface(repoKey));
      return Promise.resolve(neverAuditedSurface());
    });

    const coverage = await auditCoverageService.getCoverage(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    // Exactly one of N rejected: the other two entries are intact...
    expect(coverage.repos).toEqual([
      { repoKey: 'moooon/motir-ai', state: 'audited' },
      { repoKey: 'moooon/motir-core', state: 'unavailable' },
      { repoKey: 'moooon/motir-gateway', state: 'not_audited' },
    ]);
    // ...and the unreadable repo is NOT counted as un-audited. A nudge that says
    // "2 repositories have no audit" because a request timed out sends an admin
    // to a page where one of them looks fine.
    expect(coverage.notAuditedCount).toBe(1);
  });

  it('surfaces a non-boundary error rather than absorbing it into "unavailable"', async () => {
    const { workspace, owner, project } = await projectWithThreeRepos('inst-cov-bug');
    getCodeAuditMock.mockRejectedValue(new TypeError('a genuine bug'));

    await expect(
      auditCoverageService.getCoverage(project.id, {
        userId: owner.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('issues every per-repo read at the cheapest LEGAL findings page size', async () => {
    const { workspace, owner, project } = await projectWithThreeRepos('inst-cov-limit');
    getCodeAuditMock.mockResolvedValue(neverAuditedSurface());

    await auditCoverageService.getCoverage(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    // Asserted on the OUTGOING request, not by reading the constant. `1`, never
    // `0`: motir-ai's `parsePositiveInt` rejects 0 and would answer 502.
    expect(getCodeAuditMock).toHaveBeenCalledTimes(3);
    for (const [query] of getCodeAuditMock.mock.calls) {
      expect(query).toMatchObject({
        coreWorkspaceId: workspace.id,
        coreProjectId: project.id,
        findingsLimit: 1,
      });
    }
    expect(getCodeAuditMock.mock.calls.map(([q]) => (q as { repoKey: string }).repoKey)).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
      'moooon/motir-gateway',
    ]);
  });

  it('refuses a caller without project-manage capability, before any boundary read', async () => {
    const { workspace, project } = await projectWithThreeRepos('inst-cov-gate');
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

    await expect(
      auditCoverageService.getCoverage(project.id, {
        userId: outsider.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    expect(getCodeAuditMock).not.toHaveBeenCalled();
  });
});
