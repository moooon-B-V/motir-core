import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type {
  RawConvention,
  RawConventionSurface,
  RawCodeAuditSurface,
} from '@/lib/ai/motirAiClient';

// The Code-health surface service (Subtask 7.14.5 / MOTIR-926). The motir-ai HTTP
// client is the one sanctioned boundary mock (an external network leaf); the rest —
// workspace / project / membership — is seeded through the real services against the
// real Postgres, so this proves the read-through service's PROJECT-ADMIN GATE
// (404-not-403 cross-tenant, 403 non-admin), the raw→DTO mapping (provenance, the
// defensive health-summary parse, findings), and that writes carry the actor's id —
// independent of motir-ai. Mirrors aiUsageService.test.ts.
const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
const getConventionMock = vi.fn<(q: unknown) => Promise<RawConventionSurface>>();
const editConventionMock = vi.fn<(i: unknown) => Promise<RawConvention>>();
const approveConventionMock = vi.fn<(i: unknown) => Promise<RawConvention>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: unknown) => getCodeAuditMock(q),
  getConvention: (q: unknown) => getConventionMock(q),
  editConvention: (i: unknown) => editConventionMock(i),
  approveConvention: (i: unknown) => approveConventionMock(i),
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
  editConventionMock.mockReset();
  approveConventionMock.mockReset();
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
    expect(dto.proposed?.id).toBe('conv_1');
    expect(dto.proposed?.status).toBe('proposed');
    expect(dto.proposed?.provenance).toEqual([
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ]);
    // The internal aiProjectId never crosses into the browser-facing DTO.
    expect(JSON.stringify(dto)).not.toContain('aiProjectId');
  });

  it('maps the audit health summary + findings defensively', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getCodeAuditMock.mockResolvedValue(rawAuditSurface());

    const dto = await aiConventionService.getAudit(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

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

    // Actor A asks about project B (another workspace) — resolveInputs must 404.
    await expect(
      aiConventionService.getConvention(projectB.id, {
        userId: a.owner.id,
        workspaceId: a.workspace.id,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(getConventionMock).not.toHaveBeenCalled();
  });
});

describe('aiConventionService — writes carry the actor', () => {
  it('editConvention passes the actor userId + convention id to the boundary', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    editConventionMock.mockResolvedValue(
      rawConvention({ contentMd: '# curated', editedByUserId: owner.id }),
    );

    const dto = await aiConventionService.editConvention(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      'conv_1',
      '# curated',
    );

    expect(editConventionMock).toHaveBeenCalledWith({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      conventionId: 'conv_1',
      contentMd: '# curated',
      userId: owner.id,
    });
    expect(dto.contentMd).toBe('# curated');
  });

  it('approveConvention passes the actor userId + returns the promoted DTO', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    approveConventionMock.mockResolvedValue(
      rawConvention({ status: 'standard', approvedByUserId: owner.id }),
    );

    const dto = await aiConventionService.approveConvention(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      'conv_1',
    );

    expect(approveConventionMock).toHaveBeenCalledWith({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      conventionId: 'conv_1',
      userId: owner.id,
    });
    expect(dto.status).toBe('standard');
    expect(dto.approvedByUserId).toBe(owner.id);
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
