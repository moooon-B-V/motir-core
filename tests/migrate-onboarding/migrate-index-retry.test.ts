import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  MigrateIndexRetryRefusedError,
  MigrateOnboardingNotFoundError,
} from '@/lib/migrateOnboarding/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { mapMigrateError } from '@/app/api/onboarding/migrate/_errors';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';

// migrateOnboardingService.retryIndex — retry a connected repository's FAILED
// index from the onboarding run (Story MOTIR-8246 · MOTIR-8769), against a REAL
// Postgres. Only the motir-ai client (so the service module loads) and the index
// enqueue (so the dispatch is observable) are mocked.

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (_data: unknown) => {}),
}));

vi.mock('@/lib/github/indexEnqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/indexEnqueue')>();
  return { ...actual, enqueueCodeGraphIndex: mocks.enqueue };
});
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'a', conventionJobId: 'c' })),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [], catalog: null })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { migrateOnboardingService } = await import('@/lib/services/migrateOnboardingService');

async function seedInstallation(fx: WorkItemFixture) {
  return adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${randomToken(6)}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
}

async function seedRepo(
  inst: { id: string; workspaceId: string | null },
  name: string,
  index: { indexingRunId?: string; indexRefusedAt?: Date } = {},
): Promise<string> {
  if (!inst.workspaceId) throw new Error('seedRepo needs a workspace-bound installation');
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: inst.workspaceId,
      organizationId: await organizationIdOf(inst.workspaceId),
      repoId: `repo-${randomToken(6)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
      ...(index.indexingRunId ? { indexingRunId: index.indexingRunId } : {}),
      ...(index.indexRefusedAt
        ? {
            indexRefusedAt: index.indexRefusedAt,
            indexRefusedSizeBytes: 5n,
            indexRefusedCapBytes: 4n,
          }
        : {}),
    },
  });
  return `acme/${name}`;
}

async function seedIndexJob(
  fx: WorkItemFixture,
  status: 'running' | 'succeeded' | 'failed' | 'abandoned',
  repoRef?: string,
): Promise<string> {
  const row = await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status,
      ...(status === 'running' ? {} : { finishedAt: new Date() }),
      output: status === 'succeeded' ? { indexed: true, repoRef, projectsIndexed: 1 } : {},
    },
  });
  return row.id;
}

async function pointerOf(name: string): Promise<string | null> {
  const row = await adminDb.githubRepo.findFirst({ where: { owner: 'acme', name } });
  return row?.indexingRunId ?? null;
}

async function world() {
  const fx = await makeWorkItemFixture();
  const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
  const inst = await seedInstallation(fx);
  return { fx, run, inst };
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  mocks.enqueue.mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('migrateOnboardingService.retryIndex', () => {
  it.each(['failed', 'abandoned'] as const)(
    're-enqueues a repo whose claimed run ended %s, once, through the connect enqueue',
    async (ended) => {
      const { fx, run, inst } = await world();
      const deadRunId = await seedIndexJob(fx, ended);
      const ref = await seedRepo(inst, 'web', { indexingRunId: deadRunId });

      const before = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
      expect(before.repos[0]?.status).toBe('failed');

      const result = await migrateOnboardingService.retryIndex(run.id, ref, fx.ctx);
      expect(result).toEqual({ repoRef: ref, status: 'queued' });
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      expect(mocks.enqueue).toHaveBeenCalledWith({
        installationId: inst.installationId,
        workspaceId: fx.workspaceId,
        repoOwner: 'acme',
        repoName: 'web',
        defaultBranch: 'main',
      });
    },
  );

  it('reads queued, not failed, straight after a retry — before any run claims it', async () => {
    const { fx, run, inst } = await world();
    const deadRunId = await seedIndexJob(fx, 'failed');
    const ref = await seedRepo(inst, 'web', { indexingRunId: deadRunId });

    await migrateOnboardingService.retryIndex(run.id, ref, fx.ctx);

    // The dead claim is released, so the pointer names nothing until a run claims it.
    expect(await pointerOf('web')).toBeNull();
    const after = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(after.repos[0]?.status).toBe('queued');
    expect(after.failedCount).toBe(0);
  });

  it('two consecutive retries of a failed repo enqueue once', async () => {
    const { fx, run, inst } = await world();
    const deadRunId = await seedIndexJob(fx, 'failed');
    const ref = await seedRepo(inst, 'web', { indexingRunId: deadRunId });

    const first = await migrateOnboardingService.retryIndex(run.id, ref, fx.ctx);
    const second = await migrateOnboardingService.retryIndex(run.id, ref, fx.ctx);
    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('two concurrent retries of a failed repo enqueue once', async () => {
    const { fx, run, inst } = await world();
    const deadRunId = await seedIndexJob(fx, 'failed');
    const ref = await seedRepo(inst, 'web', { indexingRunId: deadRunId });

    const results = await Promise.all([
      migrateOnboardingService.retryIndex(run.id, ref, fx.ctx),
      migrateOnboardingService.retryIndex(run.id, ref, fx.ctx),
    ]);
    expect(results.map((r) => r.status)).toEqual(['queued', 'queued']);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues nothing and answers the current state for indexing, queued and indexed', async () => {
    const { fx, run, inst } = await world();
    const runningId = await seedIndexJob(fx, 'running');
    const indexing = await seedRepo(inst, 'indexing', { indexingRunId: runningId });
    const queued = await seedRepo(inst, 'queued');
    const indexed = await seedRepo(inst, 'indexed');
    await seedIndexJob(fx, 'succeeded', indexed);

    expect(await migrateOnboardingService.retryIndex(run.id, indexing, fx.ctx)).toEqual({
      repoRef: indexing,
      status: 'indexing',
    });
    expect(await migrateOnboardingService.retryIndex(run.id, queued, fx.ctx)).toEqual({
      repoRef: queued,
      status: 'queued',
    });
    expect(await migrateOnboardingService.retryIndex(run.id, indexed, fx.ctx)).toEqual({
      repoRef: indexed,
      status: 'indexed',
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // …and the running claim was left alone.
    expect(await pointerOf('indexing')).toBe(runningId);
  });

  it('refuses a repo outside the run’s connected set as not_connected (409)', async () => {
    const { fx, run, inst } = await world();
    await seedRepo(inst, 'web');

    const err = await migrateOnboardingService
      .retryIndex(run.id, 'acme/elsewhere', fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrateIndexRetryRefusedError);
    expect((err as MigrateIndexRetryRefusedError).reason).toBe('not_connected');
    expect(mapMigrateError(err)?.status).toBe(409);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a size-refused repo as refused_too_large (422) and enqueues nothing', async () => {
    const { fx, run, inst } = await world();
    const ref = await seedRepo(inst, 'huge', { indexRefusedAt: new Date() });

    const err = await migrateOnboardingService
      .retryIndex(run.id, ref, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrateIndexRetryRefusedError);
    expect((err as MigrateIndexRetryRefusedError).reason).toBe('refused_too_large');
    const mapped = mapMigrateError(err);
    expect(mapped?.status).toBe(422);
    expect(await mapped?.json()).toMatchObject({
      code: 'MIGRATE_INDEX_RETRY_REFUSED',
      reason: 'refused_too_large',
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a caller who cannot edit the project, through the edit gate', async () => {
    const { fx, run, inst } = await world();
    const deadRunId = await seedIndexJob(fx, 'failed');
    const ref = await seedRepo(inst, 'web', { indexingRunId: deadRunId });
    const stranger = await createTestUser();

    await expect(
      migrateOnboardingService.retryIndex(run.id, ref, {
        userId: stranger.id,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(await pointerOf('web')).toBe(deadRunId);
  });

  it('a run id outside the workspace is not found', async () => {
    const { fx } = await world();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherRun = await migrateOnboardingService.startMigration(other.projectId, other.ctx);

    await expect(
      migrateOnboardingService.retryIndex(otherRun.id, 'acme/web', fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingNotFoundError);
  });
});
