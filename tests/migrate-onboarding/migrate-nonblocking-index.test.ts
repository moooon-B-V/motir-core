import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';
import { MigrateOnboardingStepError } from '@/lib/migrateOnboarding/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// THE STORY GATE for MOTIR-8246 (MOTIR-8773): onboarding moves on while the code
// index builds, and Enter Motir ends it from the Import step while the index and
// any import keep running (design MOTIR-8767 revision A). Each predecessor card
// carries its own service tests; this file walks them ASSEMBLED, as a person's
// path, against a real Postgres. Only the motir-ai client (so "nothing was
// started" is observable on its calls) and the index enqueue (so a retry's
// dispatch is observable) are stubbed.

const mocks = vi.hoisted(() => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'a', conventionJobId: 'c' })),
  enqueue: vi.fn(async (_data: unknown) => {}),
}));

vi.mock('@/lib/github/indexEnqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/indexEnqueue')>();
  return { ...actual, enqueueCodeGraphIndex: mocks.enqueue };
});
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: mocks.submitJob,
  refreshCodeAudit: mocks.refreshCodeAudit,
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

type IndexSeed = 'queued' | 'running' | 'failed' | 'abandoned' | 'succeeded' | 'refused';
const REPO = 'acme/widgets';

/** A project with one connected repository whose index is in `index`, and a run
 *  parked at `step` with that repository as its connected ref. */
async function world(index: IndexSeed, step: 'index' | 'import' = 'index') {
  const fx = await makeWorkItemFixture();
  const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${randomToken(6)}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
  const runId = await seedIndex(fx, index);
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `repo-${randomToken(6)}`,
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
      archived: false,
      ...(runId && index !== 'succeeded' ? { indexingRunId: runId } : {}),
      ...(index === 'refused'
        ? {
            indexRefusedAt: new Date(),
            indexRefusedSizeBytes: BigInt(5),
            indexRefusedCapBytes: BigInt(4),
          }
        : {}),
    },
  });
  await adminDb.migrateOnboarding.update({
    where: { id: run.id },
    data: { step, connectedRepoRef: REPO },
  });
  return { fx, id: run.id };
}

/** The job-ledger row an index in `index` leaves behind, if any. */
async function seedIndex(fx: WorkItemFixture, index: IndexSeed): Promise<string | null> {
  if (index === 'queued' || index === 'refused') return null;
  const status = index === 'succeeded' ? 'succeeded' : index;
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
      output: status === 'succeeded' ? { indexed: true, repoRef: REPO, projectsIndexed: 1 } : {},
    },
  });
  return row.id;
}

async function seedRunningImport(fx: WorkItemFixture) {
  return adminDb.import.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      source: 'jira',
      status: 'running',
      createdCount: 30,
      updatedCount: 8,
      skippedCount: 2,
      failedCount: 0,
    },
  });
}

const readRun = (id: string) => adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id } });
const readProject = (id: string) => adminDb.project.findUniqueOrThrow({ where: { id } });
const readPointer = async () =>
  (await adminDb.githubRepo.findFirstOrThrow({ where: { owner: 'acme', name: 'widgets' } }))
    .indexingRunId;

/** "Nothing was started" — read on the stubs AND on the persisted run. */
async function expectNothingStarted(id: string) {
  expect(mocks.submitJob).not.toHaveBeenCalled();
  expect(mocks.refreshCodeAudit).not.toHaveBeenCalled();
  const row = await readRun(id);
  expect(row.generateJobId).toBeNull();
  expect(row.discoveryJobId).toBeNull();
  expect(row.conventionApprovedAt).toBeNull();
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  mocks.submitJob.mockClear();
  mocks.refreshCodeAudit.mockClear();
  mocks.enqueue.mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('onboarding moves on while the code index builds (MOTIR-8246)', () => {
  it.each(['queued', 'running', 'failed', 'succeeded'] as const)(
    '1 · a run leaves index while the index is %s',
    async (index) => {
      const { fx, id } = await world(index);
      expect((await readRun(id)).step).toBe('index');

      const dto = await migrateOnboardingService.advanceFromIndex(id, fx.ctx);

      expect(dto.step).toBe('import');
      expect((await readRun(id)).step).toBe('import');
      // The graph is called built only when it is.
      expect(dto.codeGraphReady).toBe(index === 'succeeded');
    },
  );

  it.each([
    ['queued', 'queued', 0],
    ['running', 'indexing', 0],
    ['failed', 'failed', 1],
    ['abandoned', 'failed', 1],
    ['succeeded', 'indexed', 0],
    ['refused', 'failed', 1],
  ] as const)('2 · an index seeded %s reads %s', async (index, expected, failedCount) => {
    const { fx, id } = await world(index);

    const status = await migrateOnboardingService.getIndexStatus(id, fx.ctx);

    expect(status.repos).toHaveLength(1);
    expect(status.repos[0]).toMatchObject({ repoRef: REPO, status: expected });
    expect(status.failedCount).toBe(failedCount);
  });

  it('3 · Enter Motir while indexing completes the run and leaves the index running', async () => {
    const { fx, id } = await world('running', 'import');
    const pointer = await readPointer();
    expect(pointer).not.toBeNull();
    expect((await migrateOnboardingService.getIndexStatus(id, fx.ctx)).repos[0]?.status).toBe(
      'indexing',
    );

    const dto = await migrateOnboardingService.enter(id, fx.ctx);

    expect(dto).toMatchObject({ step: 'done', status: 'completed' });
    expect(await readRun(id)).toMatchObject({ step: 'done', status: 'completed' });
    await expectNothingStarted(id);
    expect((await readProject(fx.projectId)).onboardingRanAt).toBeNull();
    expect(await readPointer()).toBe(pointer);
    expect((await migrateOnboardingService.getIndexStatus(id, fx.ctx)).repos[0]?.status).toBe(
      'indexing',
    );
  });

  it('4 · Enter Motir while an import runs completes the run and leaves the import alone', async () => {
    const { fx, id } = await world('running', 'import');
    const running = await seedRunningImport(fx);
    expect((await migrateOnboardingService.getById(id, fx.ctx)).latestImport?.status).toBe(
      'running',
    );

    const dto = await migrateOnboardingService.enter(id, fx.ctx);

    expect(dto).toMatchObject({ step: 'done', status: 'completed' });
    expect(dto.latestImport).toEqual({ source: 'jira', status: 'running', processedCount: 40 });
    expect(await adminDb.import.findUniqueOrThrow({ where: { id: running.id } })).toEqual(running);
    await expectNothingStarted(id);
  });

  it('5 · a failed index undoes nothing: Enter Motir still completes', async () => {
    const { fx, id } = await world('failed', 'import');
    const running = await seedRunningImport(fx);
    const projectBefore = await readProject(fx.projectId);
    const runBefore = await readRun(id);
    expect((await migrateOnboardingService.getIndexStatus(id, fx.ctx)).failedCount).toBe(1);

    await migrateOnboardingService.enter(id, fx.ctx);

    const runAfter = await readRun(id);
    expect(runAfter).toMatchObject({ step: 'done', status: 'completed' });
    const { step: _s1, status: _st1, updatedAt: _u1, ...restBefore } = runBefore;
    const { step: _s2, status: _st2, updatedAt: _u2, ...restAfter } = runAfter;
    expect(restAfter).toEqual(restBefore);
    expect(await readProject(fx.projectId)).toEqual(projectBefore);
    expect(await adminDb.import.findUniqueOrThrow({ where: { id: running.id } })).toEqual(running);
  });

  it('6 · a failed index is retried after the run completed, once', async () => {
    const { fx, id } = await world('failed', 'import');
    await migrateOnboardingService.enter(id, fx.ctx);
    expect((await readRun(id)).status).toBe('completed');

    const first = await migrateOnboardingService.retryIndex(id, REPO, fx.ctx);
    expect(first).toEqual({ repoRef: REPO, status: 'queued' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect((await migrateOnboardingService.getIndexStatus(id, fx.ctx)).repos[0]?.status).toBe(
      'queued',
    );

    const second = await migrateOnboardingService.retryIndex(id, REPO, fx.ctx);
    expect(second.status).toBe('queued');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('7a · a second Enter Motir on a completed run changes nothing', async () => {
    const { fx, id } = await world('running', 'import');
    await migrateOnboardingService.enter(id, fx.ctx);
    const before = await readRun(id);
    expect(before.status).toBe('completed');

    const again = await migrateOnboardingService.enter(id, fx.ctx);

    expect(again).toMatchObject({ step: 'done', status: 'completed' });
    expect(await readRun(id)).toEqual(before);
  });

  it('7b · Enter Motir from a step before index is refused and writes nothing', async () => {
    const { fx, id } = await world('running');
    await adminDb.migrateOnboarding.update({ where: { id }, data: { step: 'connect' } });
    const before = await readRun(id);
    expect(before.step).toBe('connect');

    await expect(migrateOnboardingService.enter(id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingStepError,
    );
    expect(await readRun(id)).toEqual(before);
  });

  it('7c · a caller who cannot edit the project cannot enter', async () => {
    const { fx, id } = await world('running', 'import');
    const before = await readRun(id);
    const stranger = await createTestUser();

    await expect(
      migrateOnboardingService.enter(id, { userId: stranger.id, workspaceId: fx.workspaceId }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(await readRun(id)).toEqual(before);
  });
});
