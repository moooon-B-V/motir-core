import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import type { RawCodeGraphStatus } from '@/lib/ai/motirAiClient';

// The CODE-CONTEXT service (Story MOTIR-1754 · MOTIR-1767) — the CONSUMER half of
// this story's boundary seam, against real Postgres with the motir-ai HTTP client
// as the one sanctioned boundary mock (the `aiConventionService` convention).
//
// The verdict is a TOTAL function over four states, and the branch that matters
// most is the one a reader would never write a test for: **a NULL head means
// UNKNOWN, and unknown resolves to `current`, never to `stale`.** Getting that
// default wrong puts a false "your plans are being made against old code" warning
// in front of every user connected before the head column shipped — which is every
// existing user on the day this ships.

const getCodeGraphStatusMock = vi.fn<(q: unknown) => Promise<RawCodeGraphStatus>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeGraphStatus: (q: unknown) => getCodeGraphStatusMock(q),
}));

const { codeContextService, resolveVerdict } = await import('@/lib/services/codeContextService');
const { createTestWorkspace, createTestProject } = await import('./fixtures');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

const REPO = {
  providerRepoId: '901',
  owner: 'acme',
  name: 'web',
  defaultBranch: 'main',
  archived: false,
};
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function status(over: Partial<RawCodeGraphStatus['repos'][number]> = {}): RawCodeGraphStatus {
  return {
    repos: [
      {
        repoRef: 'acme/web',
        indexed: true,
        commitSha: SHA_A,
        indexedAt: '2026-09-01T10:00:00.000Z',
        codegraphVersion: '1.2.3',
        ...over,
      },
    ],
  };
}

async function connectRepo(workspaceId: string) {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: `inst-${workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: [REPO],
  });
}

/** Set the recorded default-branch head directly — MOTIR-1766's column. */
async function setHead(headSha: string | null) {
  await adminDb.githubRepo.updateMany({
    where: { repoId: REPO.providerRepoId },
    data: { lastPushSha: headSha, lastPushedAt: headSha ? new Date() : null },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  getCodeGraphStatusMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

// ── The verdict, as a pure function ─────────────────────────────────────────
describe('resolveVerdict — TOTAL over four states', () => {
  const cases: {
    name: string;
    input: Parameters<typeof resolveVerdict>[0];
    expected: string;
  }[] = [
    {
      name: 'indexed, shas equal → current',
      input: { indexed: true, indexedCommitSha: SHA_A, headSha: SHA_A, indexingInFlight: false },
      expected: 'current',
    },
    {
      name: 'indexed, shas differ → stale',
      input: { indexed: true, indexedCommitSha: SHA_A, headSha: SHA_B, indexingInFlight: false },
      expected: 'stale',
    },
    {
      name: 'not indexed, nothing running → never_indexed',
      input: { indexed: false, indexedCommitSha: null, headSha: SHA_B, indexingInFlight: false },
      expected: 'never_indexed',
    },
    {
      name: 'not indexed, an index in flight → indexing',
      input: { indexed: false, indexedCommitSha: null, headSha: SHA_B, indexingInFlight: true },
      expected: 'indexing',
    },
    {
      name: 'indexed, NULL head → current (unknown is never stale)',
      input: { indexed: true, indexedCommitSha: SHA_A, headSha: null, indexingInFlight: false },
      expected: 'current',
    },
    {
      name: 'indexed, NULL indexed sha → current (nothing to compare)',
      input: { indexed: true, indexedCommitSha: null, headSha: SHA_B, indexingInFlight: false },
      expected: 'current',
    },
    {
      name: 'not indexed wins over a differing head — never_indexed, not stale',
      input: { indexed: false, indexedCommitSha: null, headSha: SHA_B, indexingInFlight: false },
      expected: 'never_indexed',
    },
    {
      name: 'an in-flight index cannot make an INDEXED repo read indexing',
      input: { indexed: true, indexedCommitSha: SHA_A, headSha: SHA_B, indexingInFlight: true },
      expected: 'stale',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveVerdict(c.input)).toBe(c.expected);
    });
  }

  it('a NULL head yields `current` for EVERY indexed sha — the false-warning branch', () => {
    // Its own test, because this is the one default whose wrong answer is loud,
    // wrong and shown to every user connected before MOTIR-1766 shipped.
    for (const indexedCommitSha of [SHA_A, SHA_B, null]) {
      expect(
        resolveVerdict({ indexed: true, indexedCommitSha, headSha: null, indexingInFlight: false }),
      ).toBe('current');
    }
  });
});

// ── The service ─────────────────────────────────────────────────────────────
describe('codeContextService.getCodeContext', () => {
  it('joins the connected set, the freshness and the recorded head', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectRepo(workspace.id);
    await setHead(SHA_A);
    getCodeGraphStatusMock.mockResolvedValue(status());

    const dto = await codeContextService.getCodeContext(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(dto.hasCodeContext).toBe(true);
    expect(dto.freshnessUnavailable).toBe(false);
    expect(dto.repos).toEqual([
      {
        repoRef: 'acme/web',
        provider: 'github',
        verdict: 'current',
        indexedCommitSha: SHA_A,
        indexedAt: '2026-09-01T10:00:00.000Z',
        codegraphVersion: '1.2.3',
        headSha: SHA_A,
        commitsBehind: null,
      },
    ]);
  });

  it('ONE boundary call covers the whole repo set — never one per repo', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-many',
        accountLogin: 'acme',
        accountType: 'Organization',
      },
      repos: [
        REPO,
        {
          providerRepoId: '902',
          owner: 'acme',
          name: 'worker',
          defaultBranch: 'main',
          archived: false,
        },
        {
          providerRepoId: '903',
          owner: 'acme',
          name: 'api',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    getCodeGraphStatusMock.mockResolvedValue({ repos: [] });

    await codeContextService.getCodeContext(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(getCodeGraphStatusMock).toHaveBeenCalledTimes(1);
    expect(getCodeGraphStatusMock.mock.calls[0]![0]).toMatchObject({
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      repoRefs: ['acme/api', 'acme/web', 'acme/worker'],
    });
  });

  it('a repo whose indexed commit is BEHIND the recorded head reads stale', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectRepo(workspace.id);
    await setHead(SHA_B);
    getCodeGraphStatusMock.mockResolvedValue(status({ commitSha: SHA_A }));

    const dto = await codeContextService.getCodeContext(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });
    expect(dto.repos[0]).toMatchObject({ verdict: 'stale', headSha: SHA_B, commitsBehind: null });
  });

  it('a NULL recorded head yields `current`, NEVER `stale` — its own test', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectRepo(workspace.id);
    await setHead(null); // a repo connected before MOTIR-1766 shipped
    getCodeGraphStatusMock.mockResolvedValue(status({ commitSha: SHA_A }));

    const dto = await codeContextService.getCodeContext(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });
    expect(dto.repos[0]).toMatchObject({ verdict: 'current', headSha: null });
  });

  it('a workspace with NO installation returns the no-code-context shape and NEVER calls motir-ai', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    const dto = await codeContextService.getCodeContext(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    expect(dto).toEqual({
      hasCodeContext: false,
      repos: [],
      hasImplementedWork: false,
      freshnessUnavailable: false,
    });
    // A wasted boundary round-trip for an answer already known locally.
    expect(getCodeGraphStatusMock).not.toHaveBeenCalled();
  });

  it('a motir-ai OUTAGE degrades — the surface still renders, freshness reads unavailable', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectRepo(workspace.id);
    await setHead(SHA_A);
    getCodeGraphStatusMock.mockRejectedValue(new MotirAiUnavailableError('ai down'));

    const dto = await codeContextService.getCodeContext(project.id, {
      userId: owner.id,
      workspaceId: workspace.id,
    });

    // An AI-side failure must never 500 the planning workspace.
    expect(dto.freshnessUnavailable).toBe(true);
    expect(dto.hasCodeContext).toBe(true);
    expect(dto.repos[0]).toMatchObject({
      repoRef: 'acme/web',
      verdict: 'never_indexed',
      indexedCommitSha: null,
      // The connection facts are motir-core's own and stay true.
      headSha: SHA_A,
    });
  });

  it('a NON-boundary error still throws — degradation is scoped to the boundary', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connectRepo(workspace.id);
    getCodeGraphStatusMock.mockRejectedValue(new TypeError('a real bug'));

    await expect(
      codeContextService.getCodeContext(project.id, {
        userId: owner.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('`hasImplementedWork` is any item with a non-null implementationSource — not "any done item"', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const ctx = { userId: owner.id, workspaceId: workspace.id };

    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Something' },
      ctx,
    );

    const before = await codeContextService.getCodeContext(project.id, ctx);
    expect(before.hasImplementedWork).toBe(false);

    // A project migrated from another tracker is full of DONE items nobody
    // implemented through Motir — provenance is the honest signal, not status.
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { implementationSource: 'byok' },
    });

    const after = await codeContextService.getCodeContext(project.id, ctx);
    expect(after.hasImplementedWork).toBe(true);
  });

  it('a caller who cannot BROWSE the project gets the typed access error, not code context', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const other = await createTestWorkspace();

    await expect(
      codeContextService.getCodeContext(project.id, {
        userId: other.owner.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toThrow();
    expect(getCodeGraphStatusMock).not.toHaveBeenCalled();
  });
});
