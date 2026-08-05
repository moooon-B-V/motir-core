import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type {
  RawConvention,
  RawConventionSurface,
  RawCodeAuditSurface,
} from '@/lib/ai/motirAiClient';

// The /code-health PAGE's initial read (MOTIR-2123). The page used to take
// `repos[0]!.repoRef` for BOTH surfaces, so a five-repo project could only ever
// render one convention card — even though the convention is scoped to a
// (project, repo) pair (MOTIR-1660/1662) and ConventionPanel has rendered one
// card per repo since MOTIR-1663. These pin the composition itself:
//   - N connected repos → N convention reads, one per repo, each scoped;
//   - the AUDIT stays on ONE repo (the card's explicit scope boundary: how N
//     audit reports are PRESENTED is an undesigned question, not this fix);
//   - a repo with nothing derived is dropped WITHOUT suppressing its siblings.
// Same shape as tests/boards/board-settings-page.test.ts: drive the page's own
// exported resolution helper, not the JSX. The motir-ai HTTP client is the one
// sanctioned boundary mock; workspace / project / membership are real Postgres.
const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
const getConventionMock = vi.fn<(q: { repoKey?: string }) => Promise<RawConventionSurface>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: unknown) => getCodeAuditMock(q),
  getConvention: (q: { repoKey?: string }) => getConventionMock(q),
  refreshCodeAudit: vi.fn(),
}));

const { loadCodeHealthSurfaces } = await import('@/app/(authed)/code-health/page');
const { createTestWorkspace, createTestProject } = await import('./fixtures');
const { truncateAuthTables } = await import('./helpers/db');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');

// A derived audit for one repo, with the conformance number the worst-first
// order sorts on. Shaped as motir-ai's REAL `/v1/code-audit` body — verified on
// its `origin/main` (`codeAuditService.LatestAuditSurface` + `CodeAuditDto`), not
// from motir-core's boundary type, which is how MOTIR-2127's silent field drift
// got past a whole card's worth of "the parameter is per-repo" reasoning.
function rawAudit(repoKey: string, conformancePct: number, total: number): RawCodeAuditSurface {
  return {
    audit: {
      id: `audit_${repoKey}`,
      aiProjectId: 'ai_1',
      repoKey,
      healthSummary: { grade: 'B', conformancePct, totalFindings: total },
      codeGraphRef: 'graph_1',
      scanner: null,
      jobId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total,
    nextOffset: null,
    scanner: null,
  } as unknown as RawCodeAuditSurface;
}

// ⚠️ motir-ai's REAL `GET /v1/convention` body, not motir-core's boundary type —
// see the fixture note in tests/aiConventionService.test.ts (MOTIR-2127).
function rawConvention(repoKey: string): RawConvention {
  return {
    id: `conv_${repoKey}`,
    aiProjectId: 'ai_1',
    repoKey,
    version: 1,
    contentMd: `# ${repoKey} house rules`,
    provenance: [],
    sourceAuditId: 'audit_1',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };
}

function surfaceFor(repoKey: string | undefined): RawConventionSurface {
  if (repoKey === undefined) return { convention: null, versions: [], nextCursor: null };
  const row = rawConvention(repoKey);
  return { convention: row, versions: [row], nextCursor: null };
}

const EMPTY_AUDIT: RawCodeAuditSurface = {
  audit: null,
  findings: [],
  total: 0,
  nextOffset: null,
  scanner: null,
};

const REPOS = ['moooon/motir-ai', 'moooon/motir-core', 'moooon/motir-gateway'];

beforeEach(async () => {
  await truncateAuthTables();
  getCodeAuditMock.mockReset();
  getConventionMock.mockReset();
  getCodeAuditMock.mockResolvedValue(EMPTY_AUDIT);
  getConventionMock.mockImplementation((q) => Promise.resolve(surfaceFor(q.repoKey)));
});

afterAll(async () => {
  await db.$disconnect();
});

async function admin() {
  const { workspace, owner } = await createTestWorkspace();
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  return {
    projectId: project.id,
    svcCtx: { userId: owner.id, workspaceId: workspace.id },
  };
}

describe('/code-health initial read — one convention surface PER connected repo (MOTIR-2123)', () => {
  it('composes N convention surfaces for N repos, each read with its own repoKey', async () => {
    const { projectId, svcCtx } = await admin();

    const { conventions } = await loadCodeHealthSurfaces(projectId, svcCtx, REPOS);

    expect(conventions.map((c) => c.repoKey)).toEqual(REPOS);
    expect(conventions.map((c) => c.convention?.contentMd)).toEqual(
      REPOS.map((r) => `# ${r} house rules`),
    );
    expect(getConventionMock).toHaveBeenCalledTimes(3);
    expect(getConventionMock.mock.calls.map((call) => call[0].repoKey)).toEqual(REPOS);
  });

  it('reads the AUDIT for EVERY connected repo, not just the first (MOTIR-2207)', async () => {
    const { projectId, svcCtx } = await admin();

    const { audits } = await loadCodeHealthSurfaces(projectId, svcCtx, REPOS);

    // One entry per connected repo, in connected order — the list's source. The
    // narrowing this replaces read `repoRefs[0]` and returned exactly one.
    expect(audits.map((a) => a.repoKey)).toEqual(REPOS);
    const summaryCalls = getCodeAuditMock.mock.calls.map((call) => call[0] as { repoKey: string });
    expect(summaryCalls.map((c) => c.repoKey)).toEqual(expect.arrayContaining(REPOS));
  });

  it('drops a repo with nothing derived yet WITHOUT suppressing the repos that have one', async () => {
    const { projectId, svcCtx } = await admin();
    // The middle repo has never been audited — the exact case the per-repo
    // filter exists for. Before the fan-out this could not even arise.
    getConventionMock.mockImplementation((q) =>
      Promise.resolve(surfaceFor(q.repoKey === 'moooon/motir-core' ? undefined : q.repoKey)),
    );

    const { conventions } = await loadCodeHealthSurfaces(projectId, svcCtx, REPOS);

    expect(conventions.map((c) => c.repoKey)).toEqual(['moooon/motir-ai', 'moooon/motir-gateway']);
  });

  // The REGRESSION pin for MOTIR-2207: with one connected repo the list is not
  // drawn at all (Panel 7 §7), so the read must stay exactly what it has always
  // been — ONE audit call at the full page size, no summary pass, no second trip.
  it('is unchanged for a single-repo project — one audit read, one convention card', async () => {
    const { projectId, svcCtx } = await admin();

    const { audits, selectedRepoKey, selectedAudit, conventions } = await loadCodeHealthSurfaces(
      projectId,
      svcCtx,
      ['acme/web'],
    );

    expect(selectedRepoKey).toBe('acme/web');
    expect(selectedAudit).not.toBeNull();
    expect(audits.map((a) => a.repoKey)).toEqual(['acme/web']);
    expect(conventions.map((c) => c.repoKey)).toEqual(['acme/web']);
    expect(getCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(getConventionMock).toHaveBeenCalledTimes(1);
    // Not a summary read: the one repo's report is what the tab renders.
    expect(getCodeAuditMock.mock.calls[0]![0]).not.toMatchObject({ findingsLimit: 1 });
  });

  it('reads nothing at all when no repo is connected', async () => {
    const { projectId, svcCtx } = await admin();

    const surfaces = await loadCodeHealthSurfaces(projectId, svcCtx, []);

    expect(surfaces).toEqual({
      audits: [],
      selectedRepoKey: null,
      selectedAudit: null,
      conventions: [],
    });
    expect(getCodeAuditMock).not.toHaveBeenCalled();
    expect(getConventionMock).not.toHaveBeenCalled();
  });
});

// The audit half goes plural (MOTIR-2207 · design/coding-convention Panel 7).
// The store, the boundary and the trigger were already per-repo, so one re-audit
// on a five-repo project derived five `CodeAudit` rows and the tab showed the
// one that sorted first under `owner asc, name asc` — four repos' findings
// computed, stored, paid for and invisible.
describe('/code-health initial read — an audit report for EVERY repo (MOTIR-2207)', () => {
  // conformance: motir-ai 63 · motir-core 78 · motir-gateway 34
  const GRADED: Record<string, number> = {
    'moooon/motir-ai': 63,
    'moooon/motir-core': 78,
    'moooon/motir-gateway': 34,
  };

  function gradeAll(): void {
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      const pct = GRADED[repoKey];
      return Promise.resolve(pct === undefined ? EMPTY_AUDIT : rawAudit(repoKey, pct, pct));
    });
  }

  it('selects the WORST-conforming repo and reads only its full findings page', async () => {
    const { projectId, svcCtx } = await admin();
    gradeAll();

    const { audits, selectedRepoKey, selectedAudit } = await loadCodeHealthSurfaces(
      projectId,
      svcCtx,
      REPOS,
    );

    expect(audits.map((a) => a.repoKey)).toEqual(REPOS);
    // Worst first — 34% beats the alphabetical winner, which is the whole point.
    expect(selectedRepoKey).toBe('moooon/motir-gateway');
    expect(selectedAudit?.audit?.repoKey).toBe('moooon/motir-gateway');

    // The mock sits at the BOUNDARY CLIENT, below the service — which always
    // fills the limit in (`opts.findingsLimit ?? FINDINGS_PAGE_SIZE`). So a full
    // read is the page size, never an absent param.
    const calls = getCodeAuditMock.mock.calls.map(
      (c) => c[0] as { repoKey: string; findingsLimit?: number },
    );
    // Phase 1: every repo read at SUMMARY depth (the list needs `healthSummary`
    // + `total`, never N × 100 findings). motir-ai's `parsePositiveInt` rejects
    // `0`, so the floor is 1 — a `findingsLimit=0` would be a 502, not a cheap
    // read.
    const summaries = calls.filter((c) => c.findingsLimit === 1);
    expect(summaries.map((c) => c.repoKey).sort()).toEqual([...REPOS].sort());
    // Phase 2: the selected repo ALONE, at the full page size.
    const full = calls.filter((c) => c.findingsLimit !== 1);
    expect(full.map((c) => c.repoKey)).toEqual(['moooon/motir-gateway']);
    expect(full[0]!.findingsLimit).toBeGreaterThan(1);
  });

  it('keeps a repo with NO derived audit in the list without suppressing the graded ones', async () => {
    const { projectId, svcCtx } = await admin();
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      // The middle repo has never been audited — the same "drop one, keep the
      // siblings" property MOTIR-2123 established for conventions.
      return Promise.resolve(
        repoKey === 'moooon/motir-core' ? EMPTY_AUDIT : rawAudit(repoKey, GRADED[repoKey]!, 5),
      );
    });

    const { audits, selectedRepoKey } = await loadCodeHealthSurfaces(projectId, svcCtx, REPOS);

    // Every repo still has a row — a repo with no audit is a ROW STATE, not an
    // omission, because the list is also how you discover the repo exists.
    expect(audits.map((a) => a.repoKey)).toEqual(REPOS);
    expect(audits.find((a) => a.repoKey === 'moooon/motir-core')?.surface?.audit).toBeNull();
    // …and it never takes the selection from a repo that HAS a report.
    expect(selectedRepoKey).toBe('moooon/motir-gateway');
  });

  it('degrades ONE rejecting repo to its own row and still renders the siblings', async () => {
    const { projectId, svcCtx } = await admin();
    getCodeAuditMock.mockImplementation((q) => {
      const { repoKey } = q as { repoKey: string };
      if (repoKey === 'moooon/motir-ai') {
        return Promise.reject(new MotirAiUnavailableError('boom'));
      }
      return Promise.resolve(rawAudit(repoKey, GRADED[repoKey]!, 7));
    });

    const { audits, selectedRepoKey, selectedAudit } = await loadCodeHealthSurfaces(
      projectId,
      svcCtx,
      REPOS,
    );

    // The blast radius is ONE ROW. Before this card the shared `Promise.all`
    // failed the whole page into `loadError`, taking the repos that resolved
    // down with the one that didn't.
    expect(audits.find((a) => a.repoKey === 'moooon/motir-ai')?.surface).toBeNull();
    expect(audits.find((a) => a.repoKey === 'moooon/motir-core')?.surface?.audit).not.toBeNull();
    expect(audits.find((a) => a.repoKey === 'moooon/motir-gateway')?.surface?.audit).not.toBeNull();
    // And the selection never opens the tab on the row that failed.
    expect(selectedRepoKey).toBe('moooon/motir-gateway');
    expect(selectedAudit).not.toBeNull();
  });

  it('degrades ONE rejecting CONVENTION read the same way', async () => {
    const { projectId, svcCtx } = await admin();
    gradeAll();
    getConventionMock.mockImplementation((q) =>
      q.repoKey === 'moooon/motir-core'
        ? Promise.reject(new MotirAiUnavailableError('boom'))
        : Promise.resolve(surfaceFor(q.repoKey)),
    );

    const { conventions, audits } = await loadCodeHealthSurfaces(projectId, svcCtx, REPOS);

    expect(conventions.map((c) => c.repoKey)).toEqual(['moooon/motir-ai', 'moooon/motir-gateway']);
    expect(audits).toHaveLength(3);
  });

  it('still propagates a PROJECT-GATE error — it is about the caller, not one repo', async () => {
    const { projectId, svcCtx } = await admin();
    // A non-MotirAiError must not be absorbed into a row state: the page's
    // admin-only screen depends on it reaching the caller.
    getCodeAuditMock.mockRejectedValue(new Error('not an ai error'));

    await expect(loadCodeHealthSurfaces(projectId, svcCtx, REPOS)).rejects.toThrow(
      'not an ai error',
    );
  });
});
