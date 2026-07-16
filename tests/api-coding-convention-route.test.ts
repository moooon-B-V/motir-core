import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type {
  RawConvention,
  RawConventionSurface,
  RawCodeAuditSurface,
} from '@/lib/ai/motirAiClient';

// Transport tests for the /api/ai/coding-convention/* routes (MOTIR-926/1663).
// The approve/PATCH routes are removed per MOTIR-1660/1663 (convention is
// derived + auto-used, read-only). This proves route-layer concerns:
//   - session/active-project gate (401 with no session),
//   - the DTO serialized back through NextResponse.json,
//   - the motir-ai outage → 502 mapping.

const ctxRef = { current: null as ProjectContext | null };
const sessionRef = { current: null as { user: { id: string; email: string } } | null };

vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => ctxRef.current };
});
vi.mock('@/lib/auth', () => ({ getSession: async () => sessionRef.current }));

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

const { GET: auditGET } = await import('@/app/api/ai/coding-convention/audit/route');
const { GET: conventionGET } = await import('@/app/api/ai/coding-convention/convention/route');
const { POST: refreshPOST } = await import('@/app/api/ai/coding-convention/refresh/route');
const { createTestWorkspace, createTestProject } = await import('./fixtures');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

const BASE = 'http://localhost:3000/api/ai/coding-convention';

async function signInAtProject() {
  const { workspace, owner } = await createTestWorkspace();
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  sessionRef.current = { user: { id: owner.id, email: `${owner.id}@t.dev` } };
  ctxRef.current = { userId: owner.id, workspaceId: workspace.id, projectId: project.id, project };
  return { workspace, owner, project };
}

function rawConvention(over: Partial<RawConvention> = {}): RawConvention {
  return {
    id: 'conv_1',
    aiProjectId: 'ai_1',
    status: 'proposed',
    version: 2,
    contentMd: '# rules',
    provenance: [],
    sourceAuditId: null,
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

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  sessionRef.current = null;
  getCodeAuditMock.mockReset();
  getConventionMock.mockReset();
  refreshCodeAuditMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/ai/coding-convention/audit', () => {
  it('401s with no session', async () => {
    const res = await auditGET(new Request(`${BASE}/audit`));
    expect(res.status).toBe(401);
  });

  it('returns the mapped audit surface for an admin', async () => {
    await signInAtProject();
    getCodeAuditMock.mockResolvedValue({
      audit: {
        id: 'audit_1',
        aiProjectId: 'ai_1',
        healthSummary: { grade: 'B', conformancePct: 78 },
        codeGraphRef: null,
        repoKey: 'acme/web',
        jobId: null,
        createdAt: '2026-07-04T00:00:00.000Z',
      },
      findings: [{ ruleId: 'r', category: 'layering', severity: 'high', why: 'x' }],
      total: 1,
      nextOffset: null,
    });
    const res = await auditGET(new Request(`${BASE}/audit?findingsOffset=0`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.repoKey).toBe('acme/web');
    expect(body.audit.healthSummary.grade).toBe('B');
    expect(body.findings[0].severity).toBe('high');
  });

  it('passes repoKey query param to the service', async () => {
    await signInAtProject();
    getCodeAuditMock.mockResolvedValue({
      audit: {
        id: 'audit_1',
        aiProjectId: 'ai_1',
        healthSummary: {},
        codeGraphRef: null,
        repoKey: 'acme/api',
        jobId: null,
        createdAt: '2026-07-04T00:00:00.000Z',
      },
      findings: [],
      total: 0,
      nextOffset: null,
    });
    const res = await auditGET(new Request(`${BASE}/audit?repoKey=acme%2Fapi`));
    expect(res.status).toBe(200);
    expect(getCodeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ repoKey: 'acme/api' }));
  });

  it('maps a motir-ai outage to 502', async () => {
    await signInAtProject();
    getCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await auditGET(new Request(`${BASE}/audit`));
    expect(res.status).toBe(502);
  });
});

describe('POST /api/ai/coding-convention/refresh', () => {
  it('401s with no session', async () => {
    const res = await refreshPOST();
    expect(res.status).toBe(401);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('triggers a re-audit for an admin and returns the queued job ids (202)', async () => {
    await signInAtProject();
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });
    const res = await refreshPOST();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ auditJobId: 'job_a', conventionJobId: 'job_c' });
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
  });

  it('maps a motir-ai outage to 502', async () => {
    await signInAtProject();
    refreshCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await refreshPOST();
    expect(res.status).toBe(502);
  });
});

describe('GET /api/ai/coding-convention/convention', () => {
  it('returns the mapped per-repo convention surface for an admin', async () => {
    await signInAtProject();
    getConventionMock.mockResolvedValue(rawConventionSurface());

    const res = await conventionGET(new Request(`${BASE}/convention`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repoKey).toBe('acme/web');
    expect(body.proposed.id).toBe('conv_1');
    expect(body.versions).toHaveLength(1);
  });

  it('passes repoKey query param to the service', async () => {
    await signInAtProject();
    getConventionMock.mockResolvedValue(rawConventionSurface({ repoKey: 'acme/api' }));

    const res = await conventionGET(new Request(`${BASE}/convention?repoKey=acme%2Fapi`));
    expect(res.status).toBe(200);
    expect(getConventionMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoKey: 'acme/api' }),
    );
  });
});
