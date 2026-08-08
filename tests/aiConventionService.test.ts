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
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { PermissionDeniedError, ProjectNotFoundError } = await import('@/lib/projects/errors');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { EmptyRepoScopeError, UnknownRepoScopeError } = await import('@/lib/codeHealth/errors');
const { truncateAuthTables } = await import('./helpers/db');

// ⚠️ These fixtures are motir-ai's REAL `GET /v1/convention` body — the producer's
// `CodingConventionDto` / `ConventionSurface` (`src/services/codingConventionService.ts`),
// asserted verbatim by its own real-Postgres test `tests/codeHealthSurface.test.ts`:
//   expect(await convRes.json()).toEqual({ convention: null, versions: [], nextCursor: null })
// They are NOT built from motir-core's own boundary type. Building them from the
// consumer's type is what let MOTIR-2127 ship: the mock agreed with the mapper
// while neither matched the producer, so every field the page renders was null in
// production and green in CI. Keep this keyed to motir-ai, and reread the producer
// when it changes.
function rawConvention(over: Partial<RawConvention> = {}): RawConvention {
  return {
    id: 'conv_1',
    aiProjectId: 'ai_1',
    repoKey: 'acme/web',
    version: 2,
    contentMd: '# House rules\n\n- Route → Service → Repository.',
    provenance: [
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ],
    sourceAuditId: 'audit_1',
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

/**
 * A Motir-shaped grant for the MOTIR-2123 fan-out tests: ONE workspace, several
 * connected repos. `githubRepoRepository.listByInstallation` orders `owner asc,
 * name asc`, which is what makes the collapse deterministic (`motir-ai` always
 * won) and what fixes the fan-out's expected order here.
 */
const THREE_REPOS = [
  {
    providerRepoId: '201',
    owner: 'moooon',
    name: 'motir-ai',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '202',
    owner: 'moooon',
    name: 'motir-core',
    defaultBranch: 'main',
    archived: false,
  },
  {
    providerRepoId: '203',
    owner: 'moooon',
    name: 'motir-gateway',
    defaultBranch: 'master',
    archived: false,
  },
];

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
    // The regression MOTIR-2127 fixes: the producer's `convention` reaches the
    // field the page renders instead of being dropped for a `proposed` key
    // motir-ai never sends.
    expect(dto.convention).not.toBeNull();
    expect(dto.convention?.id).toBe('conv_1');
    expect(dto.convention?.version).toBe(2);
    expect(dto.convention?.contentMd).toContain('House rules');
    expect(dto.repoKey).toBe('acme/web');
    expect(dto.convention?.provenance).toEqual([
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ]);
    expect(dto.versions).toHaveLength(1);
    expect(JSON.stringify(dto)).not.toContain('aiProjectId');
  });

  it('retires the deleted approve-lifecycle fields from the DTO (MOTIR-1660/1662)', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getConventionMock.mockResolvedValue(rawConventionSurface());

    const dto = await aiConventionService.getConvention(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    // Assert on KEYS, not on a serialized substring — `proposed` survives as a
    // provenance VALUE (adopted vs proposed), which is a different axis entirely.
    expect(Object.keys(dto).sort()).toEqual(['convention', 'nextCursor', 'repoKey', 'versions']);
    expect(Object.keys(dto.convention!).sort()).toEqual([
      'contentMd',
      'createdAt',
      'id',
      'provenance',
      'repoKey',
      'version',
    ]);
  });

  it('takes the surface repoKey from the REQUESTED repo, which motir-ai does not echo', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getConventionMock.mockResolvedValue(
      rawConventionSurface({
        convention: rawConvention({ repoKey: 'acme/api' }),
        versions: [rawConvention({ repoKey: 'acme/api' })],
      }),
    );

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
    expect(dto.convention?.repoKey).toBe('acme/api');
  });

  it('falls back to the row repoKey when the caller scoped to no repo', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getConventionMock.mockResolvedValue(rawConventionSurface());

    const dto = await aiConventionService.getConvention(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(dto.repoKey).toBe('acme/web');
  });

  it('maps motir-ai’s EMPTY surface to the null convention the empty state reads', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    // The producer's verbatim empty body (motir-ai tests/codeHealthSurface.test.ts).
    getConventionMock.mockResolvedValue({ convention: null, versions: [], nextCursor: null });

    const dto = await aiConventionService.getConvention(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      { repoKey: 'acme/web' },
    );

    expect(dto).toEqual({
      repoKey: 'acme/web',
      convention: null,
      versions: [],
      nextCursor: null,
    });
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

  // The `findingsLimit` PASSTHROUGH (MOTIR-2207 · Panel 7 §3). The multi-repo
  // list needs `healthSummary` + `total` for every connected repo and `findings`
  // for only the selected one, so reading N surfaces at the full page size would
  // ship N × 100 findings to draw an N-row list.
  it('defaults findingsLimit to the full page size', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getCodeAuditMock.mockResolvedValue(rawAuditSurface());

    await aiConventionService.getAudit(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    const q = getCodeAuditMock.mock.calls[0]![0] as { findingsLimit?: number };
    expect(q.findingsLimit).toBe(100);
  });

  it('forwards an explicit findingsLimit for a SUMMARY read', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getCodeAuditMock.mockResolvedValue(rawAuditSurface());

    await aiConventionService.getAudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      { repoKey: 'acme/web', findingsLimit: 1 },
    );

    // 1, never 0: motir-ai's `parsePositiveInt` REJECTS 0 with a
    // validation_error, so the cheapest legal summary read is one row.
    const q = getCodeAuditMock.mock.calls[0]![0] as { findingsLimit?: number; repoKey?: string };
    expect(q).toMatchObject({ repoKey: 'acme/web', findingsLimit: 1 });
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

  it('reaudit triggers the refresh over the boundary (no connected repo → one unscoped pair)', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
    );

    expect(result).toEqual({
      repos: [{ repoKey: null, auditJobId: 'job_a', conventionJobId: 'job_c' }],
    });
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    const [tenant, context, actor] = refreshCodeAuditMock.mock.calls[0]!;
    expect(tenant).toMatchObject({
      workspaceId: workspace.id,
      projectId: project.id,
      projectKey: project.identifier,
    });
    // No installation ⇒ no repo set ⇒ no `repoRef`: byte-identical to the
    // envelope this call sent before the fan-out landed (MOTIR-2123).
    expect(context).toEqual({ code: {} });
    expect(actor).toEqual({ userId: owner.id });
  });

  // ── The MOTIR-2123 fan-out ────────────────────────────────────────────────
  // The defect: ONE submit derives ONE repo (motir-ai's `parseCodeAuditInput`
  // resolves `repoRef ?? repos[0]`), so a five-repo project got one convention
  // and four repos with nothing. These pin that the trigger now submits one
  // audit + convention pair PER connected repo, each carrying its OWN `repoRef`.

  it('reaudit fans out one pair per connected repo, each carrying its own repoRef', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-reaudit-fanout',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: THREE_REPOS,
    });
    let n = 0;
    refreshCodeAuditMock.mockImplementation(() => {
      n += 1;
      return Promise.resolve({ auditJobId: `job_a${n}`, conventionJobId: `job_c${n}` });
    });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
    );

    // One pair per repo, in the mirror's stable order (owner asc, name asc).
    expect(result).toEqual({
      repos: [
        { repoKey: 'moooon/motir-ai', auditJobId: 'job_a1', conventionJobId: 'job_c1' },
        { repoKey: 'moooon/motir-core', auditJobId: 'job_a2', conventionJobId: 'job_c2' },
        { repoKey: 'moooon/motir-gateway', auditJobId: 'job_a3', conventionJobId: 'job_c3' },
      ],
    });
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(3);

    // The WHOLE context bag, exact shape: the per-repo `repoRef` — which
    // motir-ai treats as authoritative over `repos[]` — rides beside the
    // unchanged repo SET, so no boundary change is implied.
    const repoSet = [
      { provider: 'github', repoRef: 'moooon/motir-ai', defaultBranch: 'main' },
      { provider: 'github', repoRef: 'moooon/motir-core', defaultBranch: 'main' },
      { provider: 'github', repoRef: 'moooon/motir-gateway', defaultBranch: 'master' },
    ];
    expect(refreshCodeAuditMock.mock.calls.map((call) => call[1])).toEqual([
      { code: { repos: repoSet, repoRef: 'moooon/motir-ai' } },
      { code: { repos: repoSet, repoRef: 'moooon/motir-core' } },
      { code: { repos: repoSet, repoRef: 'moooon/motir-gateway' } },
    ]);
  });

  it('reaudit on a SINGLE-repo project queues exactly one pair (unchanged behaviour)', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-reaudit-single',
        accountLogin: 'acme',
        accountType: 'Organization',
      },
      repos: [THREE_REPOS[0]!],
    });
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
    );

    expect(result).toEqual({
      repos: [{ repoKey: 'moooon/motir-ai', auditJobId: 'job_a', conventionJobId: 'job_c' }],
    });
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
  });

  // ── The MOTIR-2247 repo SCOPE ─────────────────────────────────────────────
  // Deriving one repo's report must stop costing every repo's. These pin the
  // scoped fan-out, the two typed rejections, and — the one that matters most —
  // that the UNSCOPED call still submits exactly what it submitted before.

  async function connectThreeRepos(workspaceId: string, installationId: string) {
    await githubInstallationService.persistInstallation({
      workspaceId,
      installation: {
        installationId,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: THREE_REPOS,
    });
  }

  it('reaudit with a repo scope submits ONE pair per named repo and none for the others', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectThreeRepos(workspace.id, 'inst-scope-subset');
    let n = 0;
    refreshCodeAuditMock.mockImplementation(() => {
      n += 1;
      return Promise.resolve({ auditJobId: `job_a${n}`, conventionJobId: `job_c${n}` });
    });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
      { repoKeys: ['moooon/motir-gateway', 'moooon/motir-ai'] },
    );

    expect(result).toEqual({
      repos: [
        { repoKey: 'moooon/motir-gateway', auditJobId: 'job_a1', conventionJobId: 'job_c1' },
        { repoKey: 'moooon/motir-ai', auditJobId: 'job_a2', conventionJobId: 'job_c2' },
      ],
    });

    // Asserted on the recorded SUBMITS, not the return value alone: exactly two
    // envelopes, each carrying its own `repoRef`, and `moooon/motir-core` — a
    // connected repo that was NOT named — appears in none of them.
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(2);
    const repoSet = [
      { provider: 'github', repoRef: 'moooon/motir-ai', defaultBranch: 'main' },
      { provider: 'github', repoRef: 'moooon/motir-core', defaultBranch: 'main' },
      { provider: 'github', repoRef: 'moooon/motir-gateway', defaultBranch: 'master' },
    ];
    expect(refreshCodeAuditMock.mock.calls.map((call) => call[1])).toEqual([
      { code: { repos: repoSet, repoRef: 'moooon/motir-gateway' } },
      { code: { repos: repoSet, repoRef: 'moooon/motir-ai' } },
    ]);
  });

  it('reaudit with a repo scope collapses a repeated key to one pair', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectThreeRepos(workspace.id, 'inst-scope-dupe');
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
      { repoKeys: ['moooon/motir-core', 'moooon/motir-core'] },
    );

    expect(result.repos).toHaveLength(1);
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
  });

  it('reaudit REJECTS a scope naming an unconnected repo and submits NOTHING at all', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectThreeRepos(workspace.id, 'inst-scope-unknown');
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    // The scope MIXES a valid member with an invalid one: the valid one must not
    // be submitted either. A partial fan-out would spend real money deriving half
    // of what was asked for and still report the request as failed.
    await expect(
      aiConventionService.reaudit(
        project.id,
        { userId: owner.id, workspaceId: workspace.id },
        project.identifier,
        { repoKeys: ['moooon/motir-core', 'evil/elsewhere'] },
      ),
    ).rejects.toBeInstanceOf(UnknownRepoScopeError);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('reaudit REJECTS an empty scope rather than treating it as "derive nothing"', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectThreeRepos(workspace.id, 'inst-scope-empty');

    await expect(
      aiConventionService.reaudit(
        project.id,
        { userId: owner.id, workspaceId: workspace.id },
        project.identifier,
        { repoKeys: [] },
      ),
    ).rejects.toBeInstanceOf(EmptyRepoScopeError);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('reaudit with NO scope produces the identical submit sequence it produces today', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectThreeRepos(workspace.id, 'inst-scope-regression');
    let n = 0;
    refreshCodeAuditMock.mockImplementation(() => {
      n += 1;
      return Promise.resolve({ auditJobId: `job_a${n}`, conventionJobId: `job_c${n}` });
    });

    // The `opts` argument is OMITTED entirely — the call every shipped caller makes.
    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
    );

    expect(result.repos.map((r) => r.repoKey)).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
      'moooon/motir-gateway',
    ]);
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(3);
  });

  it('reaudit with an explicit undefined scope keeps the no-connected-repo unscoped pair', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });

    const result = await aiConventionService.reaudit(
      project.id,
      { userId: owner.id, workspaceId: workspace.id },
      project.identifier,
      { repoKeys: undefined },
    );

    expect(result).toEqual({
      repos: [{ repoKey: null, auditJobId: 'job_a', conventionJobId: 'job_c' }],
    });
    expect(refreshCodeAuditMock.mock.calls[0]![1]).toEqual({ code: {} });
  });

  it('reaudit checks the project-admin gate BEFORE it validates the scope', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

    // A non-admit caller sending a bad scope gets the 403, never a 422 that would
    // tell them which repos this project is connected to.
    await expect(
      aiConventionService.reaudit(
        project.id,
        { userId: outsider.id, workspaceId: workspace.id },
        project.identifier,
        { repoKeys: ['evil/elsewhere'] },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
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
    ).rejects.toBeInstanceOf(PermissionDeniedError);
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
    ).rejects.toBeInstanceOf(PermissionDeniedError);
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
