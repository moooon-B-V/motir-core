import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type {
  RawConvention,
  RawConventionSurface,
  RawCodeAuditSurface,
} from '@/lib/ai/motirAiClient';

// Transport tests for the /api/ai/coding-convention/* routes (Subtask 7.14.5 /
// MOTIR-926). The COMPANION service test (aiConventionService.test.ts) proves the
// project-admin gate + the raw→DTO mapping at the SERVICE layer against real
// Postgres; this file proves the things only the ROUTE owns:
//   - the session/active-project gate (401 with no session),
//   - the DTO serialized back through NextResponse.json (route → DTO),
//   - the PATCH body validation (400 on a missing contentMd),
//   - the motir-ai outage → 502 mapping.
// The three sanctioned mocks: getActiveProject (the context resolver the test env
// can't supply — no cookies; same exception the board/ready suites take), getSession
// (the 401 branch), and the motir-ai HTTP client leaf. The gate still runs for real
// (aiConventionService.assertCanManage) against the seeded project.

const ctxRef = { current: null as ProjectContext | null };
const sessionRef = { current: null as { user: { id: string; email: string } } | null };

vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => ctxRef.current };
});
vi.mock('@/lib/auth', () => ({ getSession: async () => sessionRef.current }));

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

const { GET: auditGET } = await import('@/app/api/ai/coding-convention/audit/route');
const { GET: conventionGET } = await import('@/app/api/ai/coding-convention/convention/route');
const { PATCH: conventionPATCH } =
  await import('@/app/api/ai/coding-convention/convention/[conventionId]/route');
const { POST: approvePOST } =
  await import('@/app/api/ai/coding-convention/convention/[conventionId]/approve/route');
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

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  sessionRef.current = null;
  getCodeAuditMock.mockReset();
  getConventionMock.mockReset();
  editConventionMock.mockReset();
  approveConventionMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

const params = (conventionId: string) => ({ params: Promise.resolve({ conventionId }) });

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
    expect(body.audit.healthSummary.grade).toBe('B');
    expect(body.findings[0].severity).toBe('high');
  });

  it('maps a motir-ai outage to 502', async () => {
    await signInAtProject();
    getCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await auditGET(new Request(`${BASE}/audit`));
    expect(res.status).toBe(502);
  });
});

describe('GET /api/ai/coding-convention/convention', () => {
  it('returns the mapped convention surface for an admin', async () => {
    await signInAtProject();
    getConventionMock.mockResolvedValue({
      proposed: rawConvention(),
      standard: null,
      versions: [rawConvention()],
      nextCursor: null,
    });
    const res = await conventionGET(new Request(`${BASE}/convention`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposed.id).toBe('conv_1');
    expect(body.versions).toHaveLength(1);
  });
});

describe('PATCH /api/ai/coding-convention/convention/:id', () => {
  it('400s a missing contentMd without calling the boundary', async () => {
    await signInAtProject();
    const res = await conventionPATCH(
      new Request(`${BASE}/convention/conv_1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      params('conv_1'),
    );
    expect(res.status).toBe(400);
    expect(editConventionMock).not.toHaveBeenCalled();
  });

  it('edits a proposed draft and returns the DTO', async () => {
    await signInAtProject();
    editConventionMock.mockResolvedValue(rawConvention({ contentMd: '# curated' }));
    const res = await conventionPATCH(
      new Request(`${BASE}/convention/conv_1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentMd: '# curated' }),
      }),
      params('conv_1'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).contentMd).toBe('# curated');
  });
});

describe('POST /api/ai/coding-convention/convention/:id/approve', () => {
  it('approves and returns the standard DTO', async () => {
    await signInAtProject();
    approveConventionMock.mockResolvedValue(rawConvention({ status: 'standard' }));
    const res = await approvePOST(
      new Request(`${BASE}/convention/conv_1/approve`, { method: 'POST' }),
      params('conv_1'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('standard');
  });

  it('401s with no session', async () => {
    const res = await approvePOST(
      new Request(`${BASE}/convention/conv_1/approve`, { method: 'POST' }),
      params('conv_1'),
    );
    expect(res.status).toBe(401);
  });
});
