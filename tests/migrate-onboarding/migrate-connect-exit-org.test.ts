import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { resolveWorkspaceConnectedRepos } from '@/lib/ai/codeContext';
import {
  MigrateOnboardingExitConditionError,
  MigrateOnboardingNotFoundError,
} from '@/lib/migrateOnboarding/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// THE CONNECT STEP'S EXIT GATE AT THE ORGANISATION TIER (Story MOTIR-8241 ·
// MOTIR-8480), against a REAL Postgres.
//
// A migrate run whose workspace holds no GitHub grant of its own, while a
// SIBLING workspace of the same organisation connected a repository, can leave
// `connect` — and the run it leaves for can finish `index`, because the gate's
// kick gives THIS workspace its own index of the repository it records.
//
// Only the motir-ai client (so the service module loads) and the index enqueue
// (so the dispatch is observable) are mocked.

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

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  // A provisioning installation has no workspace, so the cascade never reaches it.
  await adminDb.githubInstallation.deleteMany({});
  mocks.enqueue.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Org {
  organizationId: string;
  userId: string;
  /** The workspace the migrate run lives in. */
  runWorkspaceId: string;
  runProjectId: string;
  ctx: { userId: string; workspaceId: string };
  /** A sibling workspace of the same organisation. */
  siblingWorkspaceId: string;
}

/** An organisation with TWO workspaces: the run's, and a sibling. */
async function seedOrg(label: string): Promise<Org> {
  const user = await usersService.createUser({
    email: `exit-${label}-${randomInt(1000, 9999)}@example.com`,
    password: 'hunter2hunter2',
    name: label,
  });
  const { workspace: sibling } = await workspacesService.createWorkspace({
    name: `${label} sibling`,
    ownerUserId: user.id,
  });
  // The free tier caps an organisation at one workspace; a second needs a plan.
  await adminDb.organization.update({
    where: { id: sibling.organizationId },
    data: { scaledTrackerSubscription: { status: 'active', seats: 5 } },
  });
  const { workspace: runWorkspace } = await workspacesService.createWorkspace({
    name: `${label} run`,
    ownerUserId: user.id,
    organizationId: sibling.organizationId,
  });
  const project = await projectsService.createProject({
    workspaceId: runWorkspace.id,
    actorUserId: user.id,
    name: label,
    identifier: `R${randomInt(100, 1000)}`,
  });
  return {
    organizationId: sibling.organizationId,
    userId: user.id,
    runWorkspaceId: runWorkspace.id,
    runProjectId: project.id,
    ctx: { userId: user.id, workspaceId: runWorkspace.id },
    siblingWorkspaceId: sibling.id,
  };
}

async function seedInstallation(input: {
  workspaceId: string | null;
  organizationId: string | null;
  accountLogin?: string;
}) {
  return adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${randomToken(6)}`,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      accountLogin: input.accountLogin ?? 'acme',
      accountType: 'Organization',
    },
  });
}

async function seedRepo(
  installation: { id: string },
  workspaceId: string,
  organizationId: string,
  name = `web-${randomToken(6)}`,
) {
  await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId,
      organizationId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return `acme/${name}`;
}

async function seedIndexRow(workspaceId: string, status: 'running' | 'succeeded', repoRef = '') {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status,
      ...(status === 'succeeded'
        ? { finishedAt: new Date(), output: { indexed: true, repoRef, projectsIndexed: 1 } }
        : { output: {} }),
    },
  });
}

/** The sibling-workspace world: the repository is connected from the sibling. */
async function seedSiblingWorld(label = 'org') {
  const org = await seedOrg(label);
  const installation = await seedInstallation({
    workspaceId: org.siblingWorkspaceId,
    organizationId: org.organizationId,
  });
  const ref = await seedRepo(installation, org.siblingWorkspaceId, org.organizationId);
  const run = await migrateOnboardingService.startMigration(org.runProjectId, org.ctx);
  return { org, installation, ref, run };
}

function resolve(org: Org) {
  return githubInstallationService.resolveOrganizationConnectedRepos({
    userId: org.userId,
    workspaceId: org.runWorkspaceId,
    organizationId: org.organizationId,
  });
}

describe('the connect gate at the organisation tier', () => {
  it('opens for a run whose SIBLING workspace connected the repository', async () => {
    const { org, ref, run, installation } = await seedSiblingWorld();
    // The workspace-tier read sees nothing for this run's workspace…
    expect(await resolveWorkspaceConnectedRepos(org.ctx)).toBeUndefined();
    // …and the organisation-tier one sees the sibling's repository.
    const code = await resolve(org);
    expect(code?.repos.map((r) => r.repoRef)).toEqual([ref]);

    const advanced = await migrateOnboardingService.advanceNext(run.id, org.ctx);
    expect(advanced.step).toBe('index');
    expect(advanced.connectedRepoRef).toBe(ref);
    // …and THIS workspace was given its own index of that repository.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      installationId: installation.installationId,
      workspaceId: org.runWorkspaceId,
      repoOwner: 'acme',
      repoName: ref.split('/')[1],
      defaultBranch: 'main',
    });
  });

  it('agrees with the connect step’s read in the same world', async () => {
    const { org, run } = await seedSiblingWorld();
    const first = await migrateOnboardingService.getConnectState(run.id, org.ctx);
    expect(first.outcome).toBe('already_connected');
    const back = await migrateOnboardingService.getConnectState(run.id, org.ctx, {
      before: first.snapshot,
    });
    expect(back.outcome).toBe('connected');
    const advanced = await migrateOnboardingService.advanceFromConnect(run.id, org.ctx);
    expect(advanced.step).toBe('index');
  });

  it('does not regress the workspace’s own grant: a superset, and the same recorded ref', async () => {
    const org = await seedOrg('own');
    const own = await seedInstallation({
      workspaceId: org.runWorkspaceId,
      organizationId: org.organizationId,
    });
    await seedRepo(own, org.runWorkspaceId, org.organizationId, 'alpha');
    await seedRepo(own, org.runWorkspaceId, org.organizationId, 'beta');
    // A second installation from the sibling, so the org tier holds MORE.
    const sibling = await seedInstallation({
      workspaceId: org.siblingWorkspaceId,
      organizationId: org.organizationId,
      accountLogin: 'acme-two',
    });
    await seedRepo(sibling, org.siblingWorkspaceId, org.organizationId, 'gamma');

    const workspaceTier = (await resolveWorkspaceConnectedRepos(org.ctx))!.repos;
    const orgTier = (await resolve(org))!.repos;
    for (const repo of workspaceTier) {
      expect(orgTier).toContainEqual(repo);
    }
    expect(orgTier.map((r) => r.repoRef)).toContain('acme/gamma');

    const run = await migrateOnboardingService.startMigration(org.runProjectId, org.ctx);
    const advanced = await migrateOnboardingService.advanceNext(run.id, org.ctx);
    // The gate records the same first repository the workspace-tier read named.
    expect(advanced.connectedRepoRef).toBe(workspaceTier[0]!.repoRef);
  });

  it('stays shut with nothing connected — and with only the provisioning row', async () => {
    const org = await seedOrg('empty');
    const run = await migrateOnboardingService.startMigration(org.runProjectId, org.ctx);
    expect(await resolve(org)).toBeUndefined();
    await expect(migrateOnboardingService.advanceNext(run.id, org.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );

    // Motir's shared provisioning installation names neither tier.
    const provisioning = await seedInstallation({ workspaceId: null, organizationId: null });
    await seedRepo(provisioning, org.runWorkspaceId, org.organizationId, 'hosted');
    expect(await resolve(org)).toBeUndefined();
    await expect(migrateOnboardingService.advanceNext(run.id, org.ctx)).rejects.toBeInstanceOf(
      MigrateOnboardingExitConditionError,
    );

    expect(mocks.enqueue).not.toHaveBeenCalled();
    const row = await adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.step).toBe('connect');
    expect(row.connectedRepoRef).toBeNull();
  });

  it('reads an installation bound by its own organisation stamp', async () => {
    const org = await seedOrg('stamp');
    const installation = await seedInstallation({
      workspaceId: null,
      organizationId: org.organizationId,
    });
    const ref = await seedRepo(installation, org.siblingWorkspaceId, org.organizationId);
    expect((await resolve(org))?.repos.map((r) => r.repoRef)).toEqual([ref]);
  });

  it('reads an installation bound ONLY through a github_installation_org_link row', async () => {
    const org = await seedOrg('link');
    const other = await seedOrg('owner');
    // The account is stamped with ANOTHER organisation, and linked to this one.
    const installation = await seedInstallation({
      workspaceId: other.siblingWorkspaceId,
      organizationId: other.organizationId,
    });
    await adminDb.githubInstallationOrgLink.create({
      data: {
        installationId: installation.id,
        organizationId: org.organizationId,
        workspaceId: org.siblingWorkspaceId,
      },
    });
    const mine = await seedRepo(installation, org.siblingWorkspaceId, org.organizationId);
    const theirs = await seedRepo(installation, other.siblingWorkspaceId, other.organizationId);
    const refs = (await resolve(org))?.repos.map((r) => r.repoRef);
    expect(refs).toEqual([mine]);
    expect(refs).not.toContain(theirs);
  });

  it('dispatches nothing while an index is in flight in this workspace', async () => {
    const { org, run } = await seedSiblingWorld();
    await seedIndexRow(org.runWorkspaceId, 'running');
    await migrateOnboardingService.advanceNext(run.id, org.ctx);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('dispatches nothing once a success is recorded for (this workspace, that ref)', async () => {
    const { org, run, ref } = await seedSiblingWorld();
    await seedIndexRow(org.runWorkspaceId, 'succeeded', ref);
    await migrateOnboardingService.advanceNext(run.id, org.ctx);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('dispatches again for a ref only a SIBLING workspace has indexed', async () => {
    const { org, run, ref } = await seedSiblingWorld();
    await seedIndexRow(org.siblingWorkspaceId, 'succeeded', ref);
    await migrateOnboardingService.advanceNext(run.id, org.ctx);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('leaves the run at an index step it can finish', async () => {
    const { org, run, ref } = await seedSiblingWorld();
    await migrateOnboardingService.advanceNext(run.id, org.ctx);
    await seedIndexRow(org.runWorkspaceId, 'succeeded', ref);

    const status = await migrateOnboardingService.getIndexStatus(run.id, org.ctx);
    const next = await migrateOnboardingService.advanceNext(run.id, org.ctx);
    expect(status.total).toBeGreaterThanOrEqual(1);
    expect(status.allIndexed).toBe(true);
    expect(next.step).toBe('import');
  });

  it('answers the gate and the index status from ONE resolution', async () => {
    const { org, run } = await seedSiblingWorld();
    const fake = {
      repos: [{ provider: 'github', repoRef: 'fake/only', defaultBranch: 'main', indexed: false }],
    };
    const spy = vi
      .spyOn(githubInstallationService, 'resolveOrganizationConnectedRepos')
      .mockResolvedValue(fake);

    const status = await migrateOnboardingService.getIndexStatus(run.id, org.ctx);
    expect(status.repos.map((r) => r.repoRef)).toEqual(['fake/only']);
    const advanced = await migrateOnboardingService.advanceFromConnect(run.id, org.ctx);
    expect(advanced.connectedRepoRef).toBe('fake/only');
    expect(spy).toHaveBeenCalled();
    for (const [args] of spy.mock.calls) {
      expect(args).toEqual({
        userId: org.userId,
        workspaceId: org.runWorkspaceId,
        organizationId: org.organizationId,
      });
    }
  });

  it('never shows one organisation the other’s repositories', async () => {
    const a = await seedSiblingWorld('a');
    const b = await seedSiblingWorld('b');
    expect((await resolve(a.org))?.repos.map((r) => r.repoRef)).toEqual([a.ref]);
    expect((await resolve(b.org))?.repos.map((r) => r.repoRef)).toEqual([b.ref]);

    // B's run, asked for under A's context, is not found — and names nothing of B.
    const err = await migrateOnboardingService
      .getIndexStatus(b.run.id, a.org.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrateOnboardingNotFoundError);
    expect(String((err as Error).message)).not.toContain(b.ref);
    expect(String((err as Error).message)).not.toContain(b.installation.accountLogin);

    const advanced = await migrateOnboardingService.advanceNext(a.run.id, a.org.ctx);
    expect(advanced.connectedRepoRef).toBe(a.ref);
  });
});
