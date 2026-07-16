import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type {
  RawConvention,
  RawConventionSurface,
  RawCodeAuditSurface,
} from '@/lib/ai/motirAiClient';

// The Code-health surface service (MOTIR-926/1663). The motir-ai HTTP client is
// the one sanctioned boundary mock; the rest — workspace / project / membership —
// is seeded through the real services against real Postgres. The approve/edit
// write path is removed per MOTIR-1660/1663 (derived + auto-used, read-only).
const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
const getConventionMock = vi.fn<(q: unknown) => Promise<RawConventionSurface>>();
const refreshCodeAuditMock =
  vi.fn<
    (t: unknown, c: unknown, a: unknown) => Promise<{ auditJobId: string; conventionJobId: string }>
  >();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: unknown) => getCodeAuditMock(q),
  getConvention: (q: unknown) => getConventionMock(q),
  refreshCodeAudit: (t: unknown, c: unknown, a: unknown) => refreshCodeAuditMock(t, c, a),
}));

const { aiConventionService } = await import('@/lib/services/aiConventionService');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { NotProjectAdminError, ProjectNotFoundError } = await import('@/lib/projects/errors');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

function rawConvention(over: Partial<RawConvention> = {}): RawConvention {
  return {
    id: 'conv_1',
    aiProjectId: 'ai_1',
    status: 'proposed',
    version: 2,
    contentMd: '# House rules\n\n- Route → Service → Repository.',
    provenance: [
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ],
    sourceAuditId: 'audit_1',
    approvedByUserId: null,
    approvedAt: null,
    supersededByVersion: null,
    editedByUserId: null,
    editedAt: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function rawConventionSurface(over: Partial<RawConventionSurface> = {}): RawConventionSurface {
  return {
    repoKey: 'acme/web',
    proposed: rawConvention(),
    standard: null,
    versions: [rawConvention()],
    nextCursor: null,
    ...over,
  };
}

function rawAuditSurface(over: Partial<RawCodeAuditSurface> = {}): RawCodeAuditSurface {
  return {
    audit: {
      id: 'audit_1',
      aiProjectId: 'ai_1',
      healthSummary: {
        grade: 'B',
        conformancePct: 78,
        totalFindings: 2,
        byCategory: [{ category: 'layering', label: 'Layering', status: 'conforms' }],
      },
      codeGraphRef: 'acme/web@a1b9f30',
      repoKey: 'acme/web',
      jobId: 'job_1',
      createdAt: '2026-07-04T00:00:00.000Z',
    },
    findings: [
      {
        ruleId: 'layering.no-upward-imports',
        category: 'layering',
        severity: 'critical',
        fileRef: 'src/a.ts',
        symbolRef: 'foo',
        why: 'imports upward',
        conventionRuleRef: 'Layering — no upward imports',
      },
    ],
    total: 2,
    nextOffset: 1,
    ...over,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  getCodeAuditMock.mockReset();
  getConventionMock.mockReset();
  refreshCodeAuditMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('aiConventionService — project-admin gate', () => {
  it('gives a project admin the mapped convention DTO, keyed by the core ids', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getConventionMock.mockResolvedValue(rawConventionSurface());

    const dto = await aiConventionService.getConvention(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(getConventionMock).toHaveBeenCalledWith(
      expect.objectContaining({ coreWorkspaceId: workspace.id, coreProjectId: project.id }),
    );
    expect(dto.repoKey).toBe('acme/web');
    expect(dto.proposed?.id).toBe('conv_1');
    expect(dto.proposed?.status).toBe('proposed');
    expect(dto.proposed?.provenance).toEqual([
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ]);
    expect(JSON.stringify(dto)).not.toContain('aiProjectId');
  });

  it('passes repoKey scope through to the boundary query', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getConventionMock.mockResolvedValue(rawConventionSurface({ repoKey: 'acme/api' }));

    const dto = await aiConventionService.getConvention(
      project.id,
      {
        userId: owner.id,
        workspaceId: workspace.id,
      },
      { repoKey: 'acme/api' },
    );

    expect(getConventionMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoKey: 'acme/api' }),
    );
    expect(dto.repoKey).toBe('acme/api');
  });

  it('maps the audit health summary + findings defensively', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getCodeAuditMock.mockResolvedValue(rawAuditSurface());

    const dto = await aiConventionService.getAudit(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(dto.audit?.repoKey).toBe('acme/web');
    expect(dto.audit?.healthSummary.grade).toBe('B');
    expect(dto.audit?.healthSummary.conformancePct).toBe(78);
    expect(dto.audit?.healthSummary.byCategory?.[0]).toEqual({
      category: 'layering',
      label: 'Layering',
      status: 'conforms',
      detail: undefined,
    });
    expect(dto.findings[0]?.severity).toBe('critical');
    expect(dto.findings[0]?.conventionRuleRef).toBe('Layering — no upward imports');
    expect(dto.total).toBe(2);
    expect(dto.nextOffset).toBe(1);
  });

  it('maps the §10.3 scanner state onto the audit DTO when present', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getCodeAuditMock.mockResolvedValue(
      rawAuditSurface({
        scanner: {
          detected: [],
          ingested: null,
          noExternalScanner: true,
          suggestion: 'github_code_scanning',
        },
      }),
    );

    const dto = await aiConventionService.getAudit(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(dto.scanner).toEqual({
      detected: [],
      ingested: null,
      noExternalScanner: true,
      suggestion: 'github_code_scanning',
    });
  });

  it('drops an unknown scanner source + defaults scanner to null when absent', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    getCodeAuditMock.mockResolvedValueOnce(rawAuditSurface());
    const noScanner = await aiConventionService.getAudit(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });
    expect(noScanner.scanner).toBeNull();

    getCodeAuditMock.mockResolvedValueOnce(
      rawAuditSurface({
        scanner: {
          detected: ['github_code_scanning', 'bogus_source'],
          ingested: {
            source: 'github_code_scanning',
            analyses: 2,
            tools: ['CodeQL'],
            findingCount: 8,
          },
          noExternalScanner: false,
          suggestion: null,
        },
      }),
    );
    const detected = await aiConventionService.getAudit(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });
    expect(detected.scanner?.detected).toEqual(['github_code_scanning']);
    expect(detected.scanner?.noExternalScanner).toBe(false);
    expect(detected.scanner?.ingested?.tools).toEqual(['CodeQL']);
  });

  it('reaudit triggers the refresh over the boundary', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
    );

    expect(result).toEqual({ auditJobId: 'job_a', conventionJobId: 'job_c' });
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    const [tenant, context, actor] = refreshCodeAuditMock.mock.calls[0]!;
    expect(tenant).toMatchObject({
      workspaceId: workspace.id,
      projectId: project.id,
      projectKey: project.identifier,
    });
    expect(context).toEqual({ code: {} });
    expect(actor).toEqual({ userId: owner.id });
  });

  it('reaudit is blocked for a non-admin (403) without hitting the boundary', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

    await expect(
      aiConventionService.reaudit(
        project.id,
        { userId: outsider.id, workspaceId: workspace.id },
        project.identifier,
      ),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('blocks a non-admin workspace member (403) without calling the boundary', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    await expect(
      aiConventionService.getConvention(project.id, {
        userId: member.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('treats a cross-tenant project as 404 (never confirms it exists)', async () => {
    const a = await createTestWorkspace();
    const b = await createTestWorkspace();
    const projectB = await createTestProject({
      workspaceId: b.workspace.id,
      actorUserId: b.owner.id,
    });

    await expect(
      aiConventionService.getConvention(projectB.id, {
        userId: a.owner.id,
        workspaceId: a.workspace.id,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('propagates a motir-ai outage for the route to map to 502', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('down'));

    await expect(
      aiConventionService.getAudit(project.id, { userId: owner.id, workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});
