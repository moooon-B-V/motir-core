import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import {
  MigrateOnboardingExistsError,
  MigrateOnboardingExitConditionError,
  MigrateOnboardingNotFoundError,
  MigrateOnboardingStepError,
} from '@/lib/migrateOnboarding/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// migrateOnboardingService — the migrate-onboarding ("Workflow B") state-machine
// scaffolding (Story 7.15 · MOTIR-1499) against a REAL Postgres (the motir-core
// convention — no mocks). Under test the `db` role bypasses RLS, so direct reads
// assert committed state. The per-step OUTPUTS (codeGraphReady, discoveryJobId,
// …) are set here via the repository to SIMULATE the kicked actions completing
// (those kicks are no-op seams until MOTIR-931), then the transition is driven.

/** Simulate a kicked step-action landing its output on the run (the repository
 *  reach tests are allowed — CLAUDE.md — to drive DB state directly). */
async function patchRun(
  fx: WorkItemFixture,
  id: string,
  data: Prisma.MigrateOnboardingUncheckedUpdateInput,
) {
  return withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    (tx) => migrateOnboardingRepository.update(id, data, tx),
  );
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('migrateOnboardingService.startMigration', () => {
  it('creates a run at connect / active with the migrate discriminator and clean defaults', async () => {
    const fx = await makeWorkItemFixture();

    const dto = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);

    expect(dto.projectId).toBe(fx.projectId);
    expect(dto.kind).toBe('migrate');
    expect(dto.step).toBe('connect');
    expect(dto.status).toBe('active');
    expect(dto.connectedRepoRef).toBeNull();
    expect(dto.codeGraphReady).toBe(false);
    expect(dto.conventionApprovedAt).toBeNull();
    expect(dto.discoveryJobId).toBeNull();
    expect(dto.generateJobId).toBeNull();
    expect(typeof dto.createdAt).toBe('string');

    // Exactly one persisted row for the project.
    const count = await db.migrateOnboarding.count({ where: { projectId: fx.projectId } });
    expect(count).toBe(1);
  });

  it('accepts a connectedRepoRef at start', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx, {
      connectedRepoRef: 'acme/widgets',
    });
    expect(dto.connectedRepoRef).toBe('acme/widgets');
    expect(dto.step).toBe('connect');
  });

  it('rejects a second run for the same project (one per project)', async () => {
    const fx = await makeWorkItemFixture();
    await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await expect(
      migrateOnboardingService.startMigration(fx.projectId, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExistsError);
    // The pre-check short-circuits — still exactly one row.
    expect(await db.migrateOnboarding.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

describe('migrateOnboardingService reads', () => {
  it('getForProject returns null before start, then the run (the resumable head read)', async () => {
    const fx = await makeWorkItemFixture();
    expect(await migrateOnboardingService.getForProject(fx.projectId, fx.ctx)).toBeNull();

    const started = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const resumed = await migrateOnboardingService.getForProject(fx.projectId, fx.ctx);
    expect(resumed?.id).toBe(started.id);
    expect(resumed?.step).toBe('connect');
  });

  it('getById resolves the run and 404s on a bogus id', async () => {
    const fx = await makeWorkItemFixture();
    const started = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    expect((await migrateOnboardingService.getById(started.id, fx.ctx)).id).toBe(started.id);
    await expect(migrateOnboardingService.getById('nope', fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
  });

  it('re-reads the SAVED step on load — a mid-flow run resumes where it stopped (no restart-from-connect)', async () => {
    const fx = await makeWorkItemFixture();
    const started = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);

    // Persist progress to the `discovery` step (as if the earlier steps ran).
    await patchRun(fx, started.id, {
      step: 'discovery',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
      conventionApprovedAt: new Date(),
    });

    const resumed = await migrateOnboardingService.getForProject(fx.projectId, fx.ctx);
    expect(resumed?.step).toBe('discovery');
    expect(resumed?.codeGraphReady).toBe(true);
    expect(resumed?.conventionApprovedAt).not.toBeNull();

    // And it advances FROM the saved step, not from connect.
    await patchRun(fx, started.id, { discoveryJobId: 'job-d1' });
    const advanced = await migrateOnboardingService.advanceFromDiscovery(started.id, fx.ctx);
    expect(advanced.step).toBe('generate');
  });
});

describe('migrateOnboardingService step transitions — happy path', () => {
  it('walks connect → index → audit_convention → discovery → generate → review → done, completing the run', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);

    await patchRun(fx, run.id, { connectedRepoRef: 'acme/widgets' });
    let dto = await migrateOnboardingService.advanceFromConnect(run.id, fx.ctx);
    expect(dto.step).toBe('index');
    expect(dto.status).toBe('active');

    await patchRun(fx, run.id, { codeGraphReady: true });
    dto = await migrateOnboardingService.advanceFromIndex(run.id, fx.ctx);
    expect(dto.step).toBe('audit_convention');

    await patchRun(fx, run.id, { conventionApprovedAt: new Date() });
    dto = await migrateOnboardingService.advanceFromAuditConvention(run.id, fx.ctx);
    expect(dto.step).toBe('discovery');

    await patchRun(fx, run.id, { discoveryJobId: 'job-d1' });
    dto = await migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx);
    expect(dto.step).toBe('generate');

    await patchRun(fx, run.id, { generateJobId: 'job-g1' });
    dto = await migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx);
    expect(dto.step).toBe('review');
    expect(dto.status).toBe('active');

    dto = await migrateOnboardingService.advanceFromReview(run.id, fx.ctx);
    expect(dto.step).toBe('done');
    expect(dto.status).toBe('completed');
  });
});

describe('migrateOnboardingService step transitions — exit-condition guards', () => {
  it('connect blocks until a repo is connected', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await expect(
      migrateOnboardingService.advanceFromConnect(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
    // Still at connect — the failed guard did not advance the saved step.
    expect((await migrateOnboardingService.getById(run.id, fx.ctx)).step).toBe('connect');
  });

  it('index blocks until the code graph is ready', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await expect(migrateOnboardingService.advanceFromIndex(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );
  });

  it('audit_convention blocks until the convention is approved', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'audit_convention', codeGraphReady: true });
    await expect(
      migrateOnboardingService.advanceFromAuditConvention(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
  });

  it('discovery blocks until a discovery job is recorded', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'discovery' });
    await expect(
      migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
  });

  it('generate blocks until a generation job is recorded', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'generate' });
    await expect(
      migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
  });
});

describe('migrateOnboardingService step transitions — step + not-found guards', () => {
  it('rejects a transition called from the wrong step (no step-skipping / double-advance)', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    // Run is at `connect`; advancing from `index` is illegal.
    await expect(migrateOnboardingService.advanceFromIndex(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingStepError,
    );

    // Advance connect → index legitimately, then re-calling advanceFromConnect
    // (a double-advance / stale retry) is rejected by the step guard.
    await patchRun(fx, run.id, { connectedRepoRef: 'acme/widgets' });
    await migrateOnboardingService.advanceFromConnect(run.id, fx.ctx);
    await expect(
      migrateOnboardingService.advanceFromConnect(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingStepError);
  });

  it('404s a transition on a non-existent run', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      migrateOnboardingService.advanceFromConnect('nope', fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingNotFoundError);
  });
});

describe('migrateOnboardingService — tenant isolation', () => {
  it('another workspace cannot read or transition a run it does not own', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
    const run = await migrateOnboardingService.startMigration(a.projectId, a.ctx);

    // B resolves nothing for A's run id (scoped read → 404, never 403 leak).
    await expect(migrateOnboardingService.getById(run.id, b.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
    await expect(migrateOnboardingService.advanceFromConnect(run.id, b.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
    // B's own project has no run.
    expect(await migrateOnboardingService.getForProject(b.projectId, b.ctx)).toBeNull();
  });
});
