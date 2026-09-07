import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { adminDb } from './adminDb';
import { randomInt } from './random';

// THE ONE FIXTURE SHAPE IN WHICH MOTIR-4835 IS VISIBLE — a repository CONNECTED in
// one workspace and LINKED by a project in a SIBLING workspace of the same
// organisation.
//
// ⚠️ WHY IT IS A HELPER AND NOT A LOCAL `seedTenant`. Every existing fixture in
// these suites puts the `github_repo` row and its `project_repository` row in ONE
// workspace, and in that shape the defect and its fix are INDISTINGUISHABLE: the
// link is admitted by `project_repository_active_workspace` either way, so the
// suites pass identically before and after. The cross-workspace shape is the only
// one that separates them, it is fiddly to seed correctly, and MOTIR-4840 asserts
// against the same shape one service over — building it twice in two branches is
// how two subtly different definitions of one scenario end up in one suite.
//
// MOTIR-4669 made this shape SUPPORTED: a repository belongs to the organisation,
// so picking an already-connected one into a project in another of its workspaces
// is the flow the story ships and encourages.

export const MOTIR_ORG = 'motir-projects';
export const INSTALLATION_ID = '55901';
export const PROVIDER_REPO_ID = '99901';
export const REPO_NAME = 'sibling-web';

/** The SECOND organisation's repo — the control. Same installation, different org. */
export const OTHER_INSTALLATION_ID = '55902';
export const OTHER_PROVIDER_REPO_ID = '99902';
export const OTHER_REPO_NAME = 'other-org-web';

const PASSWORD = 'hunter2hunter2';

export interface SiblingWorkspaceFixture {
  organizationId: string;
  /** W1 — where the repository is CONNECTED. `github_repo.workspace_id`. */
  repoWorkspaceId: string;
  /** W2 — a SIBLING workspace of the same org, where the LINK lives. */
  linkWorkspaceId: string;
  /** The project in W2 that holds the repository in its set. */
  linkProjectId: string;
  githubRepoId: string;
  projectRepoId: string;
  userId: string;
}

export interface ControlOrgFixture {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  githubRepoId: string;
}

/**
 * Seed the cross-workspace shape.
 *
 * The repository is connected in W1 (so `github_repo` carries `workspace_id = W1`
 * and `organization_id = O1`); the `project_repository` row that realizes it is
 * created against a project in W2, a sibling workspace of the SAME organisation,
 * so the link row carries `workspace_id = W2`.
 */
export async function seedSiblingWorkspaceRepo(options?: {
  email?: string;
}): Promise<SiblingWorkspaceFixture> {
  const email = options?.email ?? `sibling-ws-${randomInt(1000, 9999)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });

  // W1 — mints the organisation, and is where the repository is connected.
  const { workspace: repoWorkspace } = await workspacesService.createWorkspace({
    name: 'Connected-in workspace',
    ownerUserId: user.id,
  });

  // ⚠️ The free tier caps an organisation at ONE workspace, so seeding the shape
  // this defect needs means lifting that cap first — a paid subscription, which
  // is what an organisation with two workspaces has in production anyway. It is
  // fixture scaffolding and orthogonal to attribution: nothing below reads it.
  await adminDb.organization.update({
    where: { id: repoWorkspace.organizationId },
    data: { scaledTrackerSubscription: { status: 'active', seats: 5 } },
  });

  // W2 — a SECOND workspace under the SAME organisation (the 6.10 path), which is
  // what makes the link row's workspace differ from the repository's.
  const { workspace: linkWorkspace } = await workspacesService.createWorkspace({
    name: 'Linking workspace',
    ownerUserId: user.id,
    organizationId: repoWorkspace.organizationId,
  });

  const linkProject = await projectsService.createProject({
    workspaceId: linkWorkspace.id,
    actorUserId: user.id,
    name: 'Sibling',
    identifier: `S${randomInt(100, 1000)}`,
  });

  await githubInstallationService.persistInstallation({
    workspaceId: repoWorkspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: PROVIDER_REPO_ID,
        owner: MOTIR_ORG,
        name: REPO_NAME,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: PROVIDER_REPO_ID },
  });

  const projectRepo = await adminDb.projectRepo.create({
    data: {
      // ⚠️ THE WHOLE POINT: the LINKING project's workspace, not the repository's.
      workspaceId: linkWorkspace.id,
      projectId: linkProject.id,
      role: 'web',
      name: REPO_NAME,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
      githubRepoId: githubRepo.id,
    },
  });

  return {
    organizationId: repoWorkspace.organizationId,
    repoWorkspaceId: repoWorkspace.id,
    linkWorkspaceId: linkWorkspace.id,
    linkProjectId: linkProject.id,
    githubRepoId: githubRepo.id,
    projectRepoId: projectRepo.id,
    userId: user.id,
  };
}

/**
 * A SECOND organisation with its own repository and link, entirely same-workspace.
 *
 * ⚠️ IT IS THE DISCRIMINATOR, not decoration. A fixture in which the caller can
 * see the whole population cannot tell a scoped read from an unscoped one — both
 * return the same rows. This org exists so the assertions can state what must NOT
 * be visible: the organisation binding widens attribution to the ORGANISATION and
 * must not widen it past one.
 */
export async function seedControlOrg(): Promise<ControlOrgFixture> {
  const user = await usersService.createUser({
    email: `control-org-${randomInt(1000, 9999)}@example.com`,
    password: PASSWORD,
    name: 'Other Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Other org workspace',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Other',
    identifier: `O${randomInt(100, 1000)}`,
  });

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: OTHER_INSTALLATION_ID,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: OTHER_PROVIDER_REPO_ID,
        owner: MOTIR_ORG,
        name: OTHER_REPO_NAME,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: OTHER_PROVIDER_REPO_ID },
  });

  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: OTHER_REPO_NAME,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
      githubRepoId: githubRepo.id,
    },
  });

  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: githubRepo.id,
  };
}

/** Four Linux jobs — 3 + 3 + 5 + 8 = 19 billable minutes, all at x1.00. */
export const STARTER_JOBS = [
  { id: 1, name: 'lint', minutes: 3 },
  { id: 2, name: 'typecheck', minutes: 3 },
  { id: 3, name: 'build', minutes: 5 },
  { id: 4, name: 'e2e', minutes: 8 },
];
export const STARTER_BILLABLE_MINUTES = 19;

function jobsPayload() {
  const started = new Date('2026-07-30T11:00:00.000Z');
  return {
    total_count: STARTER_JOBS.length,
    jobs: STARTER_JOBS.map((job) => ({
      id: job.id,
      name: job.name,
      started_at: started.toISOString(),
      completed_at: new Date(started.getTime() + job.minutes * 60_000).toISOString(),
      labels: ['ubuntu-latest'],
      run_attempt: 1,
    })),
  };
}

/** Stub the App token mint + the workflow-jobs read — the shipped convention for
 *  these suites is that the GitHub HTTP boundary is the only thing mocked. */
export function stubGithub(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_x',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/actions/runs/')) {
        return new Response(JSON.stringify(jobsPayload()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
}
