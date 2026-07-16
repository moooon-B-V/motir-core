import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { MigrateOnboardingNotFoundError } from '@/lib/migrateOnboarding/errors';

// migrateOnboardingService.getIndexStatus — the Index step's per-repo progress
// (Story 7.15 · MOTIR-934), against a REAL Postgres (the motir-core convention).
// The service module imports the motir-ai-boundary services (aiConvention /
// aiChat / aiGeneration) which import the motir-ai client, so the client is
// mocked for the module to load — getIndexStatus itself never calls motir-ai;
// it reads resolveCodeContext (the GitHub grant mirror) + the job_run ledger.

const mocks = vi.hoisted(() => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'audit-1', conventionJobId: 'conv-1' })),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [], catalog: null })),
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: mocks.submitJob,
  refreshCodeAudit: mocks.refreshCodeAudit,
  getPreplanState: mocks.getPreplanState,
  streamJob: vi.fn(),
  getJob: vi.fn(),
  approveConvention: vi.fn(),
  editConvention: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  indexCodeGraph: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { migrateOnboardingService } = await import('@/lib/services/migrateOnboardingService');

/** Seed a connected GitHub repo for the fixture's workspace so resolveCodeContext
 *  resolves it. Returns its `owner/name` ref. */
async function seedConnectedRepo(fx: WorkItemFixture, owner: string, name: string) {
  const rand = Math.random().toString(36).slice(2, 8);
  const inst = await db.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
    },
  });
  await db.githubRepo.create({
    data: { installationId: inst.id, repoId: `repo-${rand}`, owner, name, defaultBranch: 'main' },
  });
  return `${owner}/${name}`;
}

/** Seed a SUCCEEDED `system.code-graph-index` job_run for a repo. */
async function seedSucceededIndexJob(fx: WorkItemFixture, repoRef: string) {
  await db.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

/** Seed a RUNNING `system.code-graph-index` job_run (no repoRef on a running
 *  row — the index job writes `output` only on success; this is the aggregate
 *  hasRunning signal). */
async function seedRunningIndexJob(fx: WorkItemFixture) {
  await db.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      attempt: 0,
      status: 'running',
      output: {},
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('migrateOnboardingService.getIndexStatus', () => {
  it('returns an empty repo list (not allIndexed) when nothing is connected', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.repos).toEqual([]);
    expect(status.total).toBe(0);
    expect(status.indexedCount).toBe(0);
    expect(status.allIndexed).toBe(false);
    expect(status.hasRunning).toBe(false);
  });

  it('maps each connected repo to indexed/pending and gates on all', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const web = await seedConnectedRepo(fx, 'acme', 'web');
    const api = await seedConnectedRepo(fx, 'acme', 'api');
    await seedSucceededIndexJob(fx, web);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.total).toBe(2);
    expect(status.indexedCount).toBe(1);
    expect(status.allIndexed).toBe(false);
    expect(status.hasRunning).toBe(false);
    const webRow = status.repos.find((r) => r.repoRef === web);
    const apiRow = status.repos.find((r) => r.repoRef === api);
    expect(webRow?.status).toBe('indexed');
    expect(webRow?.provider).toBe('github');
    expect(apiRow?.status).toBe('pending');
  });

  it('flips allIndexed once every repo has a succeeded index run', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const web = await seedConnectedRepo(fx, 'acme', 'web');
    const api = await seedConnectedRepo(fx, 'acme', 'api');
    await seedSucceededIndexJob(fx, web);
    await seedSucceededIndexJob(fx, api);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.indexedCount).toBe(2);
    expect(status.allIndexed).toBe(true);
    expect(status.hasRunning).toBe(false);
  });

  it('reports hasRunning when an index job is in flight (aggregate, not per-repo)', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await seedConnectedRepo(fx, 'acme', 'web');
    await seedRunningIndexJob(fx);

    const status = await migrateOnboardingService.getIndexStatus(run.id, fx.ctx);
    expect(status.total).toBe(1);
    expect(status.allIndexed).toBe(false);
    expect(status.hasRunning).toBe(true);
    expect(status.repos[0]?.status).toBe('pending');
  });

  it('throws NotFound for a bogus run id', async () => {
    const fx = await makeWorkItemFixture();
    await expect(migrateOnboardingService.getIndexStatus('nope', fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
  });
});
