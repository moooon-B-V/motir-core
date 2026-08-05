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

  it("reads the AUDIT for a single repo — the first (the card's scope boundary)", async () => {
    const { projectId, svcCtx } = await admin();

    await loadCodeHealthSurfaces(projectId, svcCtx, REPOS);

    expect(getCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(getCodeAuditMock.mock.calls[0]![0]).toMatchObject({ repoKey: 'moooon/motir-ai' });
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

  it('is unchanged for a single-repo project — one audit read, one convention card', async () => {
    const { projectId, svcCtx } = await admin();

    const { audit, conventions } = await loadCodeHealthSurfaces(projectId, svcCtx, ['acme/web']);

    expect(audit).not.toBeNull();
    expect(conventions.map((c) => c.repoKey)).toEqual(['acme/web']);
    expect(getCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(getConventionMock).toHaveBeenCalledTimes(1);
  });

  it('reads nothing at all when no repo is connected', async () => {
    const { projectId, svcCtx } = await admin();

    const surfaces = await loadCodeHealthSurfaces(projectId, svcCtx, []);

    expect(surfaces).toEqual({ audit: null, conventions: [] });
    expect(getCodeAuditMock).not.toHaveBeenCalled();
    expect(getConventionMock).not.toHaveBeenCalled();
  });
});
