import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import {
  MigrateOnboardingExistsError,
  MigrateOnboardingExitConditionError,
  MigrateOnboardingNotFoundError,
  MigrateOnboardingStepError,
} from '@/lib/migrateOnboarding/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// migrateOnboardingService — the migrate-onboarding ("Workflow B") state machine
// WIRED to shipped reality (Story 7.15 · MOTIR-931), against a REAL Postgres (the
// motir-core convention). Only the motir-ai BOUNDARY client is mocked (the same
// exception the AI route/service tests take); every DB read the wiring makes runs
// for real, so the exit checks are exercised against genuine committed signals:
//   connect  → a connected repo in the GitHub grant mirror (resolveCodeContext)
//   index    → a SUCCEEDED `system.code-graph-index` job_run (the ledger poll)
//   audit    → non-blocking auto-use (MOTIR-1660): kicks reaudit, advances at once
//   discovery→ direction docs in the pre-plan state
//   generate → the generation Plan reaching `planned`
//   review   → the Plan reaching `approved`

const mocks = vi.hoisted(() => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'audit-1', conventionJobId: 'conv-1' })),
  getPreplanState: vi.fn(
    async (): Promise<{ session: null; docs: unknown[]; catalog: null }> => ({
      session: null,
      docs: [],
      catalog: null,
    }),
  ),
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: mocks.submitJob,
  refreshCodeAudit: mocks.refreshCodeAudit,
  getPreplanState: mocks.getPreplanState,
  // The remaining exports the consumed services import — unused stubs so the
  // module's named imports resolve under the full-replace mock.
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

/** A raw pre-plan doc shaped for the mapper (aiPreplanService maps raw.docs). */
function preplanDoc(kind = 'discovery') {
  return { kind, currentBody: 'direction', currentVersion: 1, summary: [], versions: [] };
}

/** Directly write run fields (the repository reach is allowed for tests) to place
 *  a run at a given step / pre-seed a kicked output. */
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

/** Seed a connected GitHub repo for the fixture's workspace so resolveCodeContext
 *  resolves it — the connect-step exit signal. Returns its `owner/name` ref. */
async function seedConnectedRepo(fx: WorkItemFixture, owner = 'acme', name = 'widgets') {
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

/** Seed a SUCCEEDED code-graph-index job_run for a repo — the index-step exit. */
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

/** Move the generation Plan bound to `sourceJobId` to a terminal review status. */
async function setPlanStatus(sourceJobId: string, status: 'planned' | 'approved') {
  await db.plan.updateMany({ where: { sourceJobId }, data: { status, plannedAt: new Date() } });
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  mocks.submitJob.mockClear();
  mocks.refreshCodeAudit.mockClear();
  mocks.getPreplanState.mockReset();
  mocks.getPreplanState.mockResolvedValue({ session: null, docs: [], catalog: null });
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
    expect(await db.migrateOnboarding.count({ where: { projectId: fx.projectId } })).toBe(1);
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
    expect(await db.migrateOnboarding.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

describe('migrateOnboardingService reads (resumable head)', () => {
  it('getForProject returns null before start, then the run', async () => {
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

  it('re-reads the SAVED step on load — a mid-flow run resumes where it stopped', async () => {
    const fx = await makeWorkItemFixture();
    const started = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, started.id, {
      step: 'discovery',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
      conventionApprovedAt: new Date(),
      discoveryJobId: 'job-discovery',
    });

    const resumed = await migrateOnboardingService.getForProject(fx.projectId, fx.ctx);
    expect(resumed?.step).toBe('discovery');
    expect(resumed?.codeGraphReady).toBe(true);

    // Advances FROM the saved step (discovery), not from connect, once its real
    // exit signal (direction docs) is present.
    mocks.getPreplanState.mockResolvedValue({ session: null, docs: [preplanDoc()], catalog: null });
    const advanced = await migrateOnboardingService.advanceFromDiscovery(started.id, fx.ctx);
    expect(advanced.step).toBe('generate');
  });
});

describe('migrateOnboardingService — connect step (GitHub grant)', () => {
  it('blocks until a repo is connected, then advances and records the repo ref', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);

    await expect(
      migrateOnboardingService.advanceFromConnect(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
    expect((await migrateOnboardingService.getById(run.id, fx.ctx)).step).toBe('connect');

    const repoRef = await seedConnectedRepo(fx);
    const dto = await migrateOnboardingService.advanceFromConnect(run.id, fx.ctx);
    expect(dto.step).toBe('index');
    expect(dto.connectedRepoRef).toBe(repoRef);
  });
});

describe('migrateOnboardingService — index step (code-graph ledger poll)', () => {
  it('blocks until the code-graph index job has succeeded, then advances', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'index', connectedRepoRef: 'acme/widgets' });

    await expect(migrateOnboardingService.advanceFromIndex(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );

    await seedSucceededIndexJob(fx, 'acme/widgets');
    const dto = await migrateOnboardingService.advanceFromIndex(run.id, fx.ctx);
    expect(dto.step).toBe('audit_convention');
    expect(dto.codeGraphReady).toBe(true);
  });

  it('a succeeded index for a DIFFERENT repo does not satisfy the gate', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await seedSucceededIndexJob(fx, 'acme/other-repo');
    await expect(migrateOnboardingService.advanceFromIndex(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );
  });
});

describe('migrateOnboardingService — audit_convention (auto-used, no gate; MOTIR-1660)', () => {
  it('kicks the audit + convention derivation SILENTLY and advances immediately', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, {
      step: 'audit_convention',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
    });

    const dto = await migrateOnboardingService.advanceFromAuditConvention(run.id, fx.ctx);
    expect(dto.step).toBe('discovery');
    expect(dto.conventionApprovedAt).not.toBeNull(); // auto-accepted
    expect(mocks.refreshCodeAudit).toHaveBeenCalledTimes(1); // derivation kicked
  });

  it('does not re-kick when the convention was already derived on a prior pass', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, {
      step: 'audit_convention',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
      conventionApprovedAt: new Date(),
    });

    const dto = await migrateOnboardingService.advanceFromAuditConvention(run.id, fx.ctx);
    expect(dto.step).toBe('discovery');
    expect(mocks.refreshCodeAudit).not.toHaveBeenCalled();
  });
});

describe('migrateOnboardingService — discovery step (direction docs)', () => {
  it('kicks a discovery job (recording its id) and blocks until direction docs exist', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, { step: 'discovery' });

    // No docs yet → blocks, but the discovery job is kicked + recorded.
    await expect(
      migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
    expect(mocks.submitJob).toHaveBeenCalledWith(
      'discovery',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect((await migrateOnboardingService.getById(run.id, fx.ctx)).discoveryJobId).toBe(
      'job-discovery',
    );

    // Docs appear → advances (the kick is not repeated — job id already set).
    mocks.getPreplanState.mockResolvedValue({ session: null, docs: [preplanDoc()], catalog: null });
    const dto = await migrateOnboardingService.advanceFromDiscovery(run.id, fx.ctx);
    expect(dto.step).toBe('generate');
    expect(mocks.submitJob).toHaveBeenCalledTimes(1);
  });
});

describe('migrateOnboardingService — generate step (code-aware precondition · MOTIR-933)', () => {
  it('blocks generation when the code graph is not yet ready', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    // codeGraphReady is false; convention is set — the FIRST gate fires.
    await patchRun(fx, run.id, {
      step: 'generate',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: false,
      conventionApprovedAt: new Date(),
      discoveryJobId: 'job-discovery',
    });

    await expect(
      migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);

    const runAfter = await migrateOnboardingService.getById(run.id, fx.ctx);
    expect(runAfter.generateJobId).toBeNull(); // never kicked
    expect(runAfter.step).toBe('generate'); // not advanced
  });

  it('blocks generation when the coding convention has not been derived yet', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    // codeGraphReady is true; convention is null — the SECOND gate fires.
    await patchRun(fx, run.id, {
      step: 'generate',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
      conventionApprovedAt: null,
      discoveryJobId: 'job-discovery',
    });

    await expect(
      migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);

    const runAfter = await migrateOnboardingService.getById(run.id, fx.ctx);
    expect(runAfter.generateJobId).toBeNull(); // never kicked
    expect(runAfter.step).toBe('generate'); // not advanced
  });

  it('proceeds with code-aware generation only when BOTH preconditions are met', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, {
      step: 'generate',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
      conventionApprovedAt: new Date(),
      discoveryJobId: 'job-discovery',
    });

    // With both preconditions met, ensureKicked fires the generation job.
    // The exit check blocks until the plan is `planned`.
    await expect(
      migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
    const generated = await migrateOnboardingService.getById(run.id, fx.ctx);
    expect(generated.generateJobId).toBe('job-generate_tree');
    expect(generated.step).toBe('generate'); // exit condition unmet → not advanced yet

    await setPlanStatus('job-generate_tree', 'planned');
    const dto = await migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx);
    expect(dto.step).toBe('review');
  });
});

describe('migrateOnboardingService — generate + review (plan status)', () => {
  it('kicks generation, blocks until the plan is planned, then approves through to done', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await patchRun(fx, run.id, {
      step: 'generate',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
      conventionApprovedAt: new Date(),
      discoveryJobId: 'job-discovery',
    });

    // Generation kicked (plan opened as `generating`) → blocks until `planned`.
    await expect(
      migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingExitConditionError);
    const generated = await migrateOnboardingService.getById(run.id, fx.ctx);
    expect(generated.generateJobId).toBe('job-generate_tree');

    await setPlanStatus('job-generate_tree', 'planned');
    let dto = await migrateOnboardingService.advanceFromGenerate(run.id, fx.ctx);
    expect(dto.step).toBe('review');

    // review blocks until the plan is approved, then completes the run.
    await expect(migrateOnboardingService.advanceFromReview(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );
    await setPlanStatus('job-generate_tree', 'approved');
    dto = await migrateOnboardingService.advanceFromReview(run.id, fx.ctx);
    expect(dto.step).toBe('done');
    expect(dto.status).toBe('completed');
  });
});

describe('migrateOnboardingService — advanceNext dispatch + guards', () => {
  it('advanceNext dispatches to the current step and reports the run complete at done', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    // connect → index via the id-only entry point.
    const dto = await migrateOnboardingService.advanceNext(run.id, fx.ctx);
    expect(dto.step).toBe('index');

    await patchRun(fx, run.id, { step: 'done', status: 'completed' });
    await expect(migrateOnboardingService.advanceNext(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );
  });

  it('rejects a transition from the wrong step (no step-skipping / double-advance)', async () => {
    const fx = await makeWorkItemFixture();
    await seedConnectedRepo(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await expect(migrateOnboardingService.advanceFromIndex(run.id, fx.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingStepError,
    );

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

    await expect(migrateOnboardingService.getById(run.id, b.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
    await expect(migrateOnboardingService.advanceFromConnect(run.id, b.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingNotFoundError,
    );
    expect(await migrateOnboardingService.getForProject(b.projectId, b.ctx)).toBeNull();
  });
});
