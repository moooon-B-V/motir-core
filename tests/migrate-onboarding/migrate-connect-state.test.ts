import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { MigrateOnboardingNotFoundError } from '@/lib/migrateOnboarding/errors';
import type { MigrateConnectOutcome } from '@/lib/dto/migrateOnboarding';

// migrateOnboardingService.getConnectState — the connect step's own read
// (Story MOTIR-8241 · MOTIR-8472), against a REAL Postgres.
//
// Two tiers sit side by side in this read ON PURPOSE: whether an installation is
// BOUND is answered for the ORGANISATION; which repositories are USABLE is the
// CONNECT exit gate's own read. So every outcome is also checked against
// `advanceFromConnect` — the gate itself — in the same test.
//
// The service module imports the motir-ai boundary services, so the motir-ai
// client is mocked for the module to load; this read never calls motir-ai.

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
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An installation STAMPED with the workspace's organisation — the
 *  `bindInstallationForWorkspace` write path. */
async function seedStampedInstallation(workspaceId: string, organizationId: string) {
  return adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${randomToken(6)}`,
      workspaceId,
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
}

/** An installation stamped with ANOTHER organisation and linked to this one only
 *  through `github_installation_org_link` — the `linkExistingInstallation` path. */
async function seedLinkOnlyInstallation(fx: WorkItemFixture) {
  const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${randomToken(6)}`,
      workspaceId: other.workspaceId,
      organizationId: other.workspace.organizationId,
      accountLogin: 'shared-account',
      accountType: 'Organization',
    },
  });
  await adminDb.githubInstallationOrgLink.create({
    data: {
      installationId: installation.id,
      organizationId: fx.workspace.organizationId,
      workspaceId: fx.workspaceId,
    },
  });
  return installation;
}

async function seedRepo(installation: { id: string }, workspaceId: string, organizationId: string) {
  const rand = randomToken(6);
  await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId,
      organizationId,
      repoId: `repo-${rand}`,
      owner: 'acme',
      name: `web-${rand}`,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return `acme/web-${rand}`;
}

/** Everything this read must never change, in one comparable value. */
async function writableState(runId: string) {
  const run = await adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id: runId } });
  return {
    run: { step: run.step, status: run.status, connectedRepoRef: run.connectedRepoRef },
    installations: await adminDb.githubInstallation.findMany({ orderBy: { id: 'asc' } }),
    links: await adminDb.githubInstallationOrgLink.findMany({ orderBy: { id: 'asc' } }),
    repos: await adminDb.githubRepo.findMany({ orderBy: { id: 'asc' } }),
  };
}

/** The gate itself, without letting a ready gate move the run. */
async function gateReady(runId: string, fx: WorkItemFixture): Promise<boolean> {
  try {
    await migrateOnboardingService.advanceFromConnect(runId, fx.ctx);
  } catch {
    return false;
  }
  // Put the run back at `connect` so the next assertion sees the same world.
  await adminDb.migrateOnboarding.update({
    where: { id: runId },
    data: { step: 'connect', connectedRepoRef: null },
  });
  return true;
}

type WorldShape = {
  name: string;
  repositories: boolean;
  bound: boolean;
  departed: boolean;
  outcome: MigrateConnectOutcome;
};

// The classification table, one row per world shape. The card's order IS the
// specification; `repositories` implies `bound` (a repository needs an
// installation), so those rows carry both.
const WORLD: WorldShape[] = [
  {
    name: 'usable repositories, never left',
    repositories: true,
    bound: true,
    departed: false,
    outcome: 'already_connected',
  },
  {
    name: 'usable repositories, came back',
    repositories: true,
    bound: true,
    departed: true,
    outcome: 'connected',
  },
  {
    name: 'bound, no repositories',
    repositories: false,
    bound: true,
    departed: true,
    outcome: 'no_repositories_selected',
  },
  {
    name: 'nothing bound, came back',
    repositories: false,
    bound: false,
    departed: true,
    outcome: 'install_cancelled',
  },
  {
    name: 'nothing bound, never left',
    repositories: false,
    bound: false,
    departed: false,
    outcome: 'not_started',
  },
];

describe('migrateOnboardingService.getConnectState — the classification table', () => {
  it.each(WORLD)('$name → $outcome, agreeing with the gate and writing nothing', async (shape) => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    if (shape.bound) {
      const installation = await seedStampedInstallation(
        fx.workspaceId,
        fx.workspace.organizationId,
      );
      if (shape.repositories) {
        await seedRepo(installation, fx.workspaceId, fx.workspace.organizationId);
      }
    }
    const { snapshot } = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    const before = shape.departed ? snapshot : undefined;

    const beforeState = await writableState(run.id);
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx, { before });
    expect(await writableState(run.id)).toEqual(beforeState);

    expect(state.outcome).toBe(shape.outcome);
    expect(state.organizationId).toBe(fx.workspace.organizationId);
    expect(state.installation.bound).toBe(shape.bound);
    expect(state.repositories).toHaveLength(shape.repositories ? 1 : 0);

    // The step's "connected" and the gate's `ready` are ONE fact.
    const ready = await gateReady(run.id, fx);
    if (state.outcome === 'connected' || state.outcome === 'already_connected') {
      expect(ready).toBe(true);
    }
    if (state.repositories.length === 0) expect(ready).toBe(false);
  });
});

describe('migrateOnboardingService.getConnectState — the read', () => {
  it('normalises the resolver’s undefined to [], present in the JSON', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(state.repositories).toEqual([]);
    expect(JSON.parse(JSON.stringify(state))).toHaveProperty('repositories', []);
    expect(state.installation).toEqual({ bound: false, accounts: [] });
  });

  it('maps a usable repository to the DTO', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const installation = await seedStampedInstallation(fx.workspaceId, fx.workspace.organizationId);
    const ref = await seedRepo(installation, fx.workspaceId, fx.workspace.organizationId);
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(state.repositories).toEqual([
      { provider: 'github', repoRef: ref, defaultBranch: 'main' },
    ]);
    expect(state.installation.accounts).toEqual([
      {
        installationRef: installation.installationId,
        accountLogin: 'acme',
        accountType: 'Organization',
      },
    ]);
  });

  it('counts an installation bound through its own organisation stamp', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await seedStampedInstallation(fx.workspaceId, fx.workspace.organizationId);
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(state.installation.bound).toBe(true);
    expect(state.outcome).toBe('no_repositories_selected');
  });

  it('counts an installation bound ONLY through a github_installation_org_link row', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const installation = await seedLinkOnlyInstallation(fx);
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(state.installation.bound).toBe(true);
    expect(state.installation.accounts.map((a) => a.installationRef)).toEqual([
      installation.installationId,
    ]);
    expect(state.outcome).toBe('no_repositories_selected');
  });

  it('lists a stamped AND linked installation once', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const installation = await seedStampedInstallation(fx.workspaceId, fx.workspace.organizationId);
    await adminDb.githubInstallationOrgLink.create({
      data: {
        installationId: installation.id,
        organizationId: fx.workspace.organizationId,
        workspaceId: fx.workspaceId,
      },
    });
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(state.installation.accounts).toHaveLength(1);
  });

  it('never counts the shared provisioning installation (null organisation)', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${randomToken(6)}`,
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-provisioning',
        accountType: 'Organization',
      },
    });
    const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(state.installation).toEqual({ bound: false, accounts: [] });
    expect(state.outcome).toBe('not_started');
  });

  it('answers the SAME organisation for a sibling workspace of the installing one', async () => {
    const user = await usersService.createUser({
      email: `connect-sibling-${randomInt(1000, 9999)}@example.com`,
      password: 'hunter2hunter2',
      name: 'Owner',
    });
    const { workspace: installedIn } = await workspacesService.createWorkspace({
      name: 'Installed in',
      ownerUserId: user.id,
    });
    // The free tier caps an organisation at one workspace; a second needs a plan.
    await adminDb.organization.update({
      where: { id: installedIn.organizationId },
      data: { scaledTrackerSubscription: { status: 'active', seats: 5 } },
    });
    const { workspace: sibling } = await workspacesService.createWorkspace({
      name: 'Sibling',
      ownerUserId: user.id,
      organizationId: installedIn.organizationId,
    });
    const project = await projectsService.createProject({
      workspaceId: sibling.id,
      actorUserId: user.id,
      name: 'Sibling',
      identifier: `S${randomInt(100, 1000)}`,
    });
    await seedStampedInstallation(installedIn.id, installedIn.organizationId);
    const ctx = { userId: user.id, workspaceId: sibling.id };
    const run = await migrateOnboardingService.startMigration(project.id, ctx);

    const state = await migrateOnboardingService.getConnectState(run.id, ctx);
    expect(state.organizationId).toBe(installedIn.organizationId);
    expect(state.installation.bound).toBe(true);
  });

  it('reads a before naming another run, an unparseable one and an absent one as absent', async () => {
    const fx = await makeWorkItemFixture();
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const otherRun = await migrateOnboardingService.startMigration(other.projectId, other.ctx);
    const { snapshot: otherSnapshot } = await migrateOnboardingService.getConnectState(
      otherRun.id,
      other.ctx,
    );
    const { snapshot } = await migrateOnboardingService.getConnectState(run.id, fx.ctx);
    expect(otherSnapshot).not.toBe(snapshot);

    for (const before of [otherSnapshot, 'not a token', 'mcs1.%%%', 'mcs9.abc', '', undefined]) {
      const state = await migrateOnboardingService.getConnectState(run.id, fx.ctx, { before });
      expect(state.outcome).toBe('not_started');
    }
    // …and the run's own snapshot is the one that witnesses departure.
    const back = await migrateOnboardingService.getConnectState(run.id, fx.ctx, {
      before: snapshot,
    });
    expect(back.outcome).toBe('install_cancelled');
  });

  it('refuses a run from another workspace without leaking its world', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const otherRun = await migrateOnboardingService.startMigration(other.projectId, other.ctx);
    const installation = await seedStampedInstallation(
      other.workspaceId,
      other.workspace.organizationId,
    );
    await seedRepo(installation, other.workspaceId, other.workspace.organizationId);
    await expect(
      migrateOnboardingService.getConnectState(otherRun.id, fx.ctx),
    ).rejects.toBeInstanceOf(MigrateOnboardingNotFoundError);
  });
});
