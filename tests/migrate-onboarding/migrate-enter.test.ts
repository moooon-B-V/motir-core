import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MigrateOnboardingStep } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  MigrateOnboardingNotFoundError,
  MigrateOnboardingStepError,
} from '@/lib/migrateOnboarding/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// migrateOnboardingService.enter — Enter Motir from the Import step (Story
// MOTIR-8246 · MOTIR-8770, design MOTIR-8767 revision A), against a REAL
// Postgres. Also pins the import step's new destination: a completed or skipped
// import ends the run instead of walking into the plan steps. Only the motir-ai
// boundary is mocked, so "nothing was started" is observable on its calls.

const ai = vi.hoisted(() => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'a', conventionJobId: 'c' })),
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: ai.submitJob,
  refreshCodeAudit: ai.refreshCodeAudit,
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

async function runAt(fx: WorkItemFixture, step: MigrateOnboardingStep) {
  const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
  await adminDb.migrateOnboarding.update({ where: { id: run.id }, data: { step } });
  return run.id;
}

async function seedImport(
  fx: WorkItemFixture,
  data: { status: 'running' | 'succeeded' | 'failed'; createdAt?: Date; counts?: number[] },
) {
  const [c = 0, u = 0, s = 0, f = 0] = data.counts ?? [];
  return adminDb.import.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      source: 'jira',
      status: data.status,
      createdCount: c,
      updatedCount: u,
      skippedCount: s,
      failedCount: f,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

const readRun = (id: string) => adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id } });
const readProject = (id: string) => adminDb.project.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  ai.submitJob.mockClear();
  ai.refreshCodeAudit.mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('migrateOnboardingService.enter', () => {
  it.each(['index', 'import'] as const)(
    'completes a run at %s and starts nothing',
    async (step) => {
      const fx = await makeWorkItemFixture();
      const id = await runAt(fx, step);

      const dto = await migrateOnboardingService.enter(id, fx.ctx);

      expect(dto).toMatchObject({ step: 'done', status: 'completed' });
      const row = await readRun(id);
      expect(row).toMatchObject({
        step: 'done',
        status: 'completed',
        importSkipped: false,
        importCompleted: false,
        generateJobId: null,
        discoveryJobId: null,
        conventionApprovedAt: null,
      });
      expect(ai.submitJob).not.toHaveBeenCalled();
      expect(ai.refreshCodeAudit).not.toHaveBeenCalled();
      expect((await readProject(fx.projectId)).onboardingRanAt).toBeNull();
    },
  );

  it('leaves a running import untouched and reports it as the latest import', async () => {
    const fx = await makeWorkItemFixture();
    const id = await runAt(fx, 'import');
    await seedImport(fx, { status: 'succeeded', createdAt: new Date(Date.now() - 60_000) });
    const running = await seedImport(fx, { status: 'running', counts: [3, 1, 1, 0] });

    const dto = await migrateOnboardingService.enter(id, fx.ctx);

    expect(dto.latestImport).toEqual({ source: 'jira', status: 'running', processedCount: 5 });
    const after = await adminDb.import.findUniqueOrThrow({ where: { id: running.id } });
    expect(after).toEqual(running);
  });

  it('is idempotent on a run that is already done', async () => {
    const fx = await makeWorkItemFixture();
    const id = await runAt(fx, 'import');
    await migrateOnboardingService.enter(id, fx.ctx);
    const before = await readRun(id);

    const again = await migrateOnboardingService.enter(id, fx.ctx);

    expect(again).toMatchObject({ step: 'done', status: 'completed' });
    expect(await readRun(id)).toEqual(before);
  });

  it.each(['connect', 'audit_convention', 'generate'] as const)(
    'refuses a run at %s as the wrong step and writes nothing',
    async (step) => {
      const fx = await makeWorkItemFixture();
      const id = await runAt(fx, step);
      const before = await readRun(id);

      await expect(migrateOnboardingService.enter(id, fx.ctx)).rejects.toBeInstanceOf(
        MigrateOnboardingStepError,
      );
      expect(await readRun(id)).toEqual(before);
    },
  );

  it('refuses a caller who cannot edit the project', async () => {
    const fx = await makeWorkItemFixture();
    const id = await runAt(fx, 'import');
    const stranger = await createTestUser();

    await expect(
      migrateOnboardingService.enter(id, { userId: stranger.id, workspaceId: fx.workspaceId }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect((await readRun(id)).step).toBe('import');
  });

  it('a run id outside the workspace is not found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherId = await runAt(other, 'import');

    await expect(migrateOnboardingService.enter(otherId, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
  });
});

describe('the import step ends the run (MOTIR-8770)', () => {
  it('skipImport completes the run instead of moving to audit_convention', async () => {
    const fx = await makeWorkItemFixture();
    const id = await runAt(fx, 'import');

    const dto = await migrateOnboardingService.skipImport(id, fx.ctx);

    expect(dto).toMatchObject({ step: 'done', status: 'completed', importSkipped: true });
    expect(ai.refreshCodeAudit).not.toHaveBeenCalled();
  });

  it('a completed import advances the run to done', async () => {
    const fx = await makeWorkItemFixture();
    const id = await runAt(fx, 'import');
    await seedImport(fx, { status: 'succeeded', counts: [2, 0, 0, 0] });

    const dto = await migrateOnboardingService.advanceNext(id, fx.ctx);

    expect(dto).toMatchObject({ step: 'done', status: 'completed', importCompleted: true });
    expect(dto.latestImport).toEqual({ source: 'jira', status: 'succeeded', processedCount: 2 });
    expect(ai.submitJob).not.toHaveBeenCalled();
  });

  it('a run with no import reports latestImport as null', async () => {
    const fx = await makeWorkItemFixture();
    const id = await runAt(fx, 'import');
    expect((await migrateOnboardingService.getById(id, fx.ctx)).latestImport).toBeNull();
  });
});
