import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import type { RawCodeGraphStatus } from '@/lib/ai/motirAiClient';

// The PLANNING-SESSION code context (Story MOTIR-1754 · MOTIR-4604) — the half of
// `context.code` that lets a session say something TRUE about its own freshness.
//
// The guarantee under test is not "a refresh is enqueued". It is that **the
// session never announces a fetch that is not happening**: the REASON explains and
// the IN-FLIGHT FLAG decides which exits the gate (MOTIR-4601) may offer, and they
// are two facts because they answer two questions. A session that says "I've
// started a refresh" while nothing is running would be a new instance of exactly
// the silent dishonesty this story exists to remove, wearing the fix's clothes.

const getCodeGraphStatusMock = vi.fn<(q: unknown) => Promise<RawCodeGraphStatus>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeGraphStatus: (q: unknown) => getCodeGraphStatusMock(q),
}));

const enqueueMock = vi.fn<(d: unknown) => Promise<void>>();
vi.mock('@/lib/github/indexEnqueue', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, enqueueCodeGraphRefresh: (d: unknown) => enqueueMock(d) };
});

const { resolvePlanningCodeContext, resolveRefreshDisposition } =
  await import('@/lib/ai/codeContext');
const { createTestWorkspace, createTestProject } = await import('./fixtures');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { truncateAuthTables } = await import('./helpers/db');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const REPO = {
  providerRepoId: '901',
  owner: 'acme',
  name: 'web',
  defaultBranch: 'main',
  archived: false,
};

async function connect(workspaceId: string, provider?: 'gitlab') {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: `inst-${workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: [REPO],
    ...(provider ? { provider } : {}),
  });
  if (provider) {
    await adminDb.githubRepo.updateMany({
      where: { repoId: REPO.providerRepoId },
      data: { provider },
    });
  }
}

async function setHead(headSha: string | null) {
  await adminDb.githubRepo.updateMany({
    where: { repoId: REPO.providerRepoId },
    data: { lastPushSha: headSha, lastPushedAt: headSha ? new Date() : null },
  });
}

function indexed(commitSha: string | null, isIndexed = true): RawCodeGraphStatus {
  return {
    repos: [
      {
        repoRef: 'acme/web',
        indexed: isIndexed,
        commitSha,
        indexedAt: isIndexed ? '2026-09-01T10:00:00.000Z' : null,
        codegraphVersion: isIndexed ? '1.2.3' : null,
      },
    ],
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  getCodeGraphStatusMock.mockReset();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await db.$disconnect();
});

// ── The disposition, as a pure function: EVERY reason arm is drivable ───────
describe('resolveRefreshDisposition — a TOTAL mapping, two arms shipping unreachable', () => {
  it('a CURRENT graph enqueues nothing, carries no reason and reports nothing in flight', () => {
    expect(resolveRefreshDisposition({ verdict: 'current', canIndex: true })).toEqual({
      refreshInFlight: false,
      enqueue: false,
    });
  });

  it('STALE and indexable → the session enqueues, and the wait is honest', () => {
    expect(resolveRefreshDisposition({ verdict: 'stale', canIndex: true })).toEqual({
      reason: 'refresh_enqueued',
      refreshInFlight: true,
      enqueue: true,
    });
  });

  it('INDEXING → already running: in flight, nothing to enqueue', () => {
    expect(resolveRefreshDisposition({ verdict: 'indexing', canIndex: true })).toEqual({
      reason: 'refresh_pending',
      refreshInFlight: true,
      enqueue: false,
    });
  });

  it('NEVER INDEXED → no wait is offered; a first index is the connect path’s', () => {
    expect(resolveRefreshDisposition({ verdict: 'never_indexed', canIndex: true })).toEqual({
      reason: 'never_indexed',
      refreshInFlight: false,
      enqueue: false,
    });
  });

  it('a host that CANNOT be indexed outranks every other explanation', () => {
    // Nothing to enqueue and no wait to offer, whatever else is true — so it is
    // checked before `paused` and before `refresh_failing` rather than after.
    for (const verdict of ['stale', 'indexing', 'never_indexed'] as const) {
      expect(resolveRefreshDisposition({ verdict, canIndex: false })).toEqual({
        reason: 'provider_unsupported',
        refreshInFlight: false,
        enqueue: false,
      });
    }
    expect(
      resolveRefreshDisposition({
        verdict: 'stale',
        canIndex: false,
        paused: true,
        refreshFailing: true,
      }),
    ).toMatchObject({ reason: 'provider_unsupported' });
  });

  it('PAUSED and FAILING are pinned now, and both offer NO wait', () => {
    // ⚠️ Both ship UNREACHABLE from production signals, on purpose — `paused`
    // waits on MOTIR-4593, and no per-repo failure signal exists (a refresh run
    // writes `output.repoRef` only on SUCCESS, so a failed row cannot be
    // attributed to a repository at all). They are pinned HERE, from constructed
    // inputs, so the day a producer lands the arm is already correct and tested.
    expect(resolveRefreshDisposition({ verdict: 'stale', canIndex: true, paused: true })).toEqual({
      reason: 'paused',
      refreshInFlight: false,
      enqueue: false,
    });
    expect(
      resolveRefreshDisposition({ verdict: 'stale', canIndex: true, refreshFailing: true }),
    ).toEqual({ reason: 'refresh_failing', refreshInFlight: false, enqueue: false });
  });

  it('EVERY reason value is produced by some input — none is unreachable by accident', () => {
    // AC 3: a new reason cannot appear without a consumer. This is the pin.
    const produced = new Set(
      (
        [
          { verdict: 'stale', canIndex: true },
          { verdict: 'indexing', canIndex: true },
          { verdict: 'never_indexed', canIndex: true },
          { verdict: 'stale', canIndex: false },
          { verdict: 'stale', canIndex: true, refreshFailing: true },
          { verdict: 'stale', canIndex: true, paused: true },
        ] as Parameters<typeof resolveRefreshDisposition>[0][]
      )
        .map((i) => resolveRefreshDisposition(i).reason)
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    );
    expect([...produced].sort()).toEqual([
      'never_indexed',
      'paused',
      'provider_unsupported',
      'refresh_enqueued',
      'refresh_failing',
      'refresh_pending',
    ]);
  });

  it('NO reason value names a commercial cause — no credit, allowance or quota word', () => {
    // MOTIR-4541: a paused reason names the STATE, never why in cost terms, and
    // nothing a session could echo into a card body a customer reads.
    const all = [
      'refresh_enqueued',
      'refresh_pending',
      'never_indexed',
      'provider_unsupported',
      'refresh_failing',
      'paused',
    ];
    for (const reason of all) {
      expect(reason).not.toMatch(/credit|allowance|quota|balance|billing|cost|spend|exhaust/i);
    }
  });
});

// ── The producer, end to end ────────────────────────────────────────────────
describe('resolvePlanningCodeContext', () => {
  it('a STALE graph enqueues a refresh THROUGH the shipped debounced path, and says so', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    getCodeGraphStatusMock.mockResolvedValue(indexed(SHA_A));

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      repoRef: 'acme/web',
      verdict: 'stale',
      reason: 'refresh_enqueued',
      refreshInFlight: true,
      indexedCommitSha: SHA_A,
      headSha: SHA_B,
      commitsBehind: null,
    });
    // Through `enqueueCodeGraphRefresh` — so the 2-min debounce and its cap apply,
    // rather than a second trigger with its own semantics.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]![0]).toMatchObject({
      workspaceId: workspace.id,
      repoOwner: 'acme',
      repoName: 'web',
      defaultBranch: 'main',
    });
  });

  it('repeated session starts stay IN FLIGHT on every one of them — not only the first', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    getCodeGraphStatusMock.mockResolvedValue(indexed(SHA_A));
    const args = { userId: owner.id, workspaceId: workspace.id, projectId: project.id };

    const runs = [
      await resolvePlanningCodeContext(args),
      await resolvePlanningCodeContext(args),
      await resolvePlanningCodeContext(args),
    ];

    // ⚠️ A DEBOUNCED NO-OP STILL COUNTS AS IN FLIGHT. The coalescing happens in
    // the scheduler — five sessions in ten minutes are five events and ONE run —
    // so every session must still be told a wait is honest. Backwards, the
    // come-back exit goes silent exactly when it is most useful.
    for (const code of runs) {
      expect(code?.repos[0]).toMatchObject({ reason: 'refresh_enqueued', refreshInFlight: true });
    }
  });

  it('a CURRENT graph enqueues nothing, adds no reason and reports no refresh', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_A);
    getCodeGraphStatusMock.mockResolvedValue(indexed(SHA_A));

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({ verdict: 'current', refreshInFlight: false });
    expect(code?.repos[0]).not.toHaveProperty('reason');
    // The common path is untouched.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a NEVER-INDEXED repo enqueues NOTHING and offers no wait', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    getCodeGraphStatusMock.mockResolvedValue(indexed(null, false));

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      verdict: 'never_indexed',
      reason: 'never_indexed',
      refreshInFlight: false,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a provider that CANNOT be indexed enqueues nothing and offers no wait', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id, 'gitlab');
    await setHead(SHA_B);
    getCodeGraphStatusMock.mockResolvedValue(indexed(SHA_A));

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos[0]).toMatchObject({
      reason: 'provider_unsupported',
      refreshInFlight: false,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('NO connected repo returns undefined — `context.code` is omitted, nothing is enqueued', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    // Byte-identical to a code-less envelope, exactly as before this card.
    expect(code).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(getCodeGraphStatusMock).not.toHaveBeenCalled();
  });

  it('the session is NEVER blocked by the enqueue — a queue failure is logged and planning proceeds', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await connect(workspace.id);
    await setHead(SHA_B);
    getCodeGraphStatusMock.mockResolvedValue(indexed(SHA_A));
    enqueueMock.mockRejectedValue(new Error('queue down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await resolvePlanningCodeContext({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });

    expect(code?.repos).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
