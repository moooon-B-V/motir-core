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
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { parseRepoScopeBody, parseOffsetParam, parseLimitParam, mapCodeHealthError } =
  await import('@/app/api/ai/coding-convention/_shared');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

const BASE = 'http://localhost:3000/api/ai/coding-convention';

// Two connected repos, so a scoped refresh has something to NOT submit for.
// `listByInstallation` orders `owner asc, name asc`.
const ROUTE_REPOS = [
  {
    providerRepoId: '301',
    owner: 'moooon',
    name: 'motir-ai',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '302',
    owner: 'moooon',
    name: 'motir-core',
    defaultBranch: 'main',
    archived: false,
  },
];

async function signInAtProject() {
  const { workspace, owner } = await createTestWorkspace();
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  sessionRef.current = { user: { id: owner.id, email: `${owner.id}@t.dev` } };
  ctxRef.current = { userId: owner.id, workspaceId: workspace.id, projectId: project.id, project };
  return { workspace, owner, project };
}

// ⚠️ motir-ai's REAL `GET /v1/convention` body (`ConventionSurface` /
// `CodingConventionDto`), not motir-core's own boundary type — see the fixture
// note in tests/aiConventionService.test.ts (MOTIR-2127).
function rawConvention(over: Partial<RawConvention> = {}): RawConvention {
  return {
    id: 'conv_1',
    aiProjectId: 'ai_1',
    repoKey: 'acme/web',
    version: 2,
    contentMd: '# rules',
    provenance: [],
    sourceAuditId: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function rawConventionSurface(over: Partial<RawConventionSurface> = {}): RawConventionSurface {
  return {
    convention: rawConvention(),
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
  // ⚠️ The SHIPPED island posts with NO body and NO content-type
  // (`fetch(REFRESH_URL, { method: 'POST' })`, CodeHealthClient) — so this,
  // not a `{}` body, is the request the whole-set path must keep serving
  // (MOTIR-2247).
  const bodylessRequest = () => new Request(`${BASE}/refresh`, { method: 'POST' });
  const scopedRequest = (body: unknown) =>
    new Request(`${BASE}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('401s with no session', async () => {
    const res = await refreshPOST(bodylessRequest());
    expect(res.status).toBe(401);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('triggers a re-audit for an admin and returns the queued job ids per repo (202)', async () => {
    await signInAtProject();
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });
    const res = await refreshPOST(bodylessRequest());
    expect(res.status).toBe(202);
    const body = await res.json();
    // The workspace has no installation here, so the fan-out submits the single
    // unscoped pair (MOTIR-2123) — the per-repo shape, one entry.
    expect(body).toEqual({
      repos: [{ repoKey: null, auditJobId: 'job_a', conventionJobId: 'job_c' }],
    });
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
  });

  it('maps a motir-ai outage to 502', async () => {
    await signInAtProject();
    refreshCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await refreshPOST(bodylessRequest());
    expect(res.status).toBe(502);
  });

  it('403s a project member and 404s a NON-BROWSER — the `ai:configure` gate, both arms', async () => {
    // MOTIR-2362 re-pointed these four operations from `assertCanManage` to
    // `assertPermission(…, 'ai:configure')`. No actor's answer changed — admin
    // holds both — but the refusal now NAMES the key, and it comes in two shapes.
    // Both are asserted here because the pair is what the ordering rule is about:
    // a browser who lacks the key is forbidden, a non-browser is missing.
    const { workspace, owner, project } = await signInAtProject();

    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    sessionRef.current = { user: { id: member.id, email: `${member.id}@t.dev` } };
    ctxRef.current = {
      userId: member.id,
      workspaceId: workspace.id,
      projectId: project.id,
      project,
    };
    const forbidden = await refreshPOST(bodylessRequest());
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).permission).toBe('ai:configure');
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();

    // …and a NON-BROWSER gets the 404 instead. ⚠️ The outsider is created AFTER
    // the project goes private: `setAccessLevel('private')` auto-seeds the
    // then-current workspace members as project members, so an actor enrolled
    // beforehand would still browse and this would assert the 403 again.
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: { userId: owner.id, workspaceId: workspace.id },
      level: 'private',
    });
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });
    sessionRef.current = { user: { id: outsider.id, email: `${outsider.id}@t.dev` } };
    ctxRef.current = {
      userId: outsider.id,
      workspaceId: workspace.id,
      projectId: project.id,
      project,
    };
    const missing = await refreshPOST(bodylessRequest());
    expect(missing.status).toBe(404);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  // ── The MOTIR-2247 repo scope ────────────────────────────────────────────
  // The route half: an optional body that narrows the fan-out, with the
  // no-body path pinned unchanged above.

  it('forwards a repo scope to the service — one pair for the named repo only', async () => {
    const { workspace } = await signInAtProject();
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-route-scope',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: ROUTE_REPOS,
    });
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const res = await refreshPOST(scopedRequest({ repoKeys: ['moooon/motir-core'] }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      repos: [{ repoKey: 'moooon/motir-core', auditJobId: 'job_a', conventionJobId: 'job_c' }],
    });
    // The OTHER connected repo is untouched — the whole point of the card.
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(refreshCodeAuditMock.mock.calls[0]![1]).toMatchObject({
      code: { repoRef: 'moooon/motir-core' },
    });
  });

  it('422s a scope naming a repo the project is not connected to, submitting nothing', async () => {
    await signInAtProject();
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const res = await refreshPOST(scopedRequest({ repoKeys: ['evil/elsewhere'] }));

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('UNKNOWN_REPO_SCOPE');
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('422s an EMPTY scope rather than answering a cheerful 202 for zero work', async () => {
    await signInAtProject();

    const res = await refreshPOST(scopedRequest({ repoKeys: [] }));

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('EMPTY_REPO_SCOPE');
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['repoKeys of the wrong type', { repoKeys: 'moooon/motir-core' }],
    ['repoKeys holding a non-string', { repoKeys: ['moooon/motir-core', 7] }],
    ['a top-level array', ['moooon/motir-core']],
  ])('400s a malformed body (%s) without reaching the service', async (_label, body) => {
    await signInAtProject();

    const res = await refreshPOST(scopedRequest(body));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MALFORMED_REPO_SCOPE');
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('treats a well-formed body with no repoKeys as the whole-set fan-out', async () => {
    await signInAtProject();
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const res = await refreshPOST(scopedRequest({}));

    expect(res.status).toBe(202);
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(refreshCodeAuditMock.mock.calls[0]![1]).toEqual({ code: {} });
  });
});

// The route layer's shared parsing + error-mapping helpers, exercised directly.
// `parseRepoScopeBody` is the MOTIR-2247 addition; the two query-param parsers
// and the rethrow arm are the pre-existing neighbours the same file gates.
describe('coding-convention route helpers', () => {
  it('parseRepoScopeBody reads an absent body as "no scope", not a parse failure', async () => {
    const req = new Request(`${BASE}/refresh`, { method: 'POST' });
    expect(await parseRepoScopeBody(req)).toEqual({ ok: true, repoKeys: undefined });
  });

  it('parseRepoScopeBody reads an explicit null repoKeys as "no scope"', async () => {
    const req = new Request(`${BASE}/refresh`, {
      method: 'POST',
      body: JSON.stringify({ repoKeys: null }),
    });
    expect(await parseRepoScopeBody(req)).toEqual({ ok: true, repoKeys: undefined });
  });

  it('parseRepoScopeBody rejects an empty-string repo key', async () => {
    const req = new Request(`${BASE}/refresh`, {
      method: 'POST',
      body: JSON.stringify({ repoKeys: ['moooon/motir-core', '  '] }),
    });
    expect(await parseRepoScopeBody(req)).toEqual({ ok: false });
  });

  it('parseRepoScopeBody treats an UNREADABLE body as malformed, never as "no scope"', async () => {
    // Reading it as "no scope" would answer a broken request with a whole-set
    // fan-out — N derivations paid for by a stream error.
    const req = { text: () => Promise.reject(new Error('stream reset')) } as unknown as Request;
    expect(await parseRepoScopeBody(req)).toEqual({ ok: false });
  });

  it('parseRepoScopeBody passes an EMPTY array through for the service to reject', async () => {
    const req = new Request(`${BASE}/refresh`, {
      method: 'POST',
      body: JSON.stringify({ repoKeys: [] }),
    });
    expect(await parseRepoScopeBody(req)).toEqual({ ok: true, repoKeys: [] });
  });

  it('mapCodeHealthError rethrows an unknown error so it becomes a genuine 500', () => {
    const boom = new Error('boom');
    expect(() => mapCodeHealthError(boom)).toThrow(boom);
  });

  it.each([
    [null, undefined],
    ['0', 0],
    ['12', 12],
    ['-1', undefined],
    ['1.5', undefined],
    ['nope', undefined],
  ])('parseOffsetParam(%s) → %s', (raw, expected) => {
    expect(parseOffsetParam(raw)).toBe(expected);
  });

  it.each([
    [null, undefined],
    // 1 is the FLOOR: motir-ai's `parsePositiveInt` rejects 0 outright.
    ['0', undefined],
    ['1', 1],
    ['100', 100],
    ['2.5', undefined],
    ['nope', undefined],
  ])('parseLimitParam(%s) → %s', (raw, expected) => {
    expect(parseLimitParam(raw)).toBe(expected);
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
    expect(body.convention.id).toBe('conv_1');
    expect(body.convention.contentMd).toBe('# rules');
    expect(body.versions).toHaveLength(1);
  });

  it('passes repoKey query param to the service and labels the surface with it', async () => {
    await signInAtProject();
    getConventionMock.mockResolvedValue(
      rawConventionSurface({
        convention: rawConvention({ repoKey: 'acme/api' }),
        versions: [rawConvention({ repoKey: 'acme/api' })],
      }),
    );

    const res = await conventionGET(new Request(`${BASE}/convention?repoKey=acme%2Fapi`));
    expect(res.status).toBe(200);
    expect(getConventionMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoKey: 'acme/api' }),
    );
    expect((await res.json()).repoKey).toBe('acme/api');
  });

  it('serializes the EMPTY surface a project with no derived convention gets', async () => {
    await signInAtProject();
    getConventionMock.mockResolvedValue({ convention: null, versions: [], nextCursor: null });

    const res = await conventionGET(new Request(`${BASE}/convention?repoKey=acme%2Fweb`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repoKey: 'acme/web',
      convention: null,
      versions: [],
      nextCursor: null,
    });
  });
});
