import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { projectRepoEstablishService } from '@/lib/services/projectRepoEstablishService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectStateService } from '@/lib/services/projectStateService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// THE TWO REMAINING WORKSPACE-TIER INSTALLATION HOPS — MOTIR-4838, the sweep
// MOTIR-4836's fix-direction item 5 asked for and the two call sites it left.
//
// ⚠️ THE FIXTURE IS THE WHOLE POINT, exactly as it is in
// `installationOrganisationTenancy.test.ts`: ONE ORGANISATION, TWO WORKSPACES.
// A single-workspace fixture passes with the bug and without it, because with
// one workspace `workspace_id = app.workspace_id` and the organisation tier name
// the same rows — which is why nothing that existed before caught either site.
//
// The two sites did the identical two-step hop:
//
//     const installation = await githubInstallationRepository.findByWorkspaceId(...)
//     const repos = installation ? await githubRepoRepository.listByInstallation(...) : []
//
// `findByWorkspaceId` compares `workspace_id` in the SQL, and a repository (with
// its installation) belongs to the ORGANISATION as of MOTIR-4669 — so from every
// workspace OTHER than the one the App was installed from, line one answered
// null and line two never ran.
//
//   * `projectStateService` → `get_project_state` reported `installed: false`
//     with an empty index. That tool exists so a planning agent can VERIFY a
//     tenant precondition instead of asserting one (MOTIR-1968); a confident,
//     wrong `no` from it is worse than no read at all.
//   * `projectRepoEstablishService` → the project's repo-connect picker offered
//     ZERO repositories and the surface read "connect the App first" for an
//     organisation that has.
//
// ⚠️ THE TIER MOVED; THE QUESTION DID NOT — and that boundary is what keeps the
// fix from being a different wrong answer. Both sites report what the TENANT has
// CONNECTED, and a connection has been the ORGANISATION's since MOTIR-4669, so
// both ask the organisation. Neither is re-pointed at the PROJECT's repository
// set: `get_project_state` already reports that separately as `repoSet`, and
// collapsing the two would delete a distinction the DTO documents and
// `tests/mcp/get-project-state.test.ts` pins twice — a grant covering no
// repositories is a different state from no installation, and a project's set is
// a different question from what its tenant has connected. The project-scoped
// re-point is `resolveCodeContext`'s, and it is MOTIR-4653's card.
//
// Real Postgres, no mocks (the repo convention).

const PASSWORD = 'hunter2hunter2';

const CORE: NormalizedRepo = {
  providerRepoId: '4838-core',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
  archived: false,
};

const AI: NormalizedRepo = {
  providerRepoId: '4838-ai',
  owner: 'moooon',
  name: 'motir-ai',
  defaultBranch: 'main',
  archived: false,
};

interface Fixture {
  userId: string;
  organizationId: string;
  /** The workspace the App was installed FROM. */
  installingWorkspaceId: string;
  /** Its SIBLING in the same organisation — it connects nothing itself. */
  siblingWorkspaceId: string;
}

/** One organisation, two workspaces, one owner who is a member of both. */
async function makeOrgWithTwoWorkspaces(email: string): Promise<Fixture> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace: first } = await workspacesService.createWorkspace({
    name: 'Moooon',
    ownerUserId: user.id,
  });
  const { workspace: second } = await workspacesService.createWorkspace({
    name: 'Taq',
    ownerUserId: user.id,
    // The one argument that makes this fixture different from every other one in
    // the suite — the second workspace joins the FIRST's organisation.
    organizationId: first.organizationId,
  });
  return {
    userId: user.id,
    organizationId: first.organizationId,
    installingWorkspaceId: first.id,
    siblingWorkspaceId: second.id,
  };
}

let fx: Fixture;
/** A project in the SIBLING workspace — the one that could see nothing. */
let sibling: { ctx: ServiceContext; projectId: string; projectKey: string };

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeOrgWithTwoWorkspaces('project-state-4838@example.com');
  await githubInstallationService.persistInstallation({
    workspaceId: fx.installingWorkspaceId,
    installation: {
      installationId: 'inst-4838-moooon',
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    },
    repos: [CORE, AI],
  });
  const project = await projectsService.createProject({
    workspaceId: fx.siblingWorkspaceId,
    actorUserId: fx.userId,
    name: 'Taq',
    identifier: 'TAQ',
  });
  sibling = {
    ctx: { userId: fx.userId, workspaceId: fx.siblingWorkspaceId },
    projectId: project.id,
    projectKey: project.identifier,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The internal `GithubRepo.id` of one of the organisation's repositories. */
async function orgRepoId(name: string): Promise<string> {
  const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { name } });
  return repo.id;
}

/** Give the sibling workspace's project a SET row realizing an org repository —
 *  the ordinary shape for a project in a second workspace: it uses code the
 *  organisation connected, and it connected none of its own. */
async function claimForSiblingProject(name: string): Promise<void> {
  const row = await projectRepoSetService.addRow(
    sibling.projectId,
    { role: 'api', name },
    sibling.ctx,
  );
  await projectRepoSetService.attachRealizedRepo(row.id, await orgRepoId(name), sibling.ctx);
}

// ── SITE 4 · `projectStateService.resolveCodeState` ──────────────────────────

describe('`get_project_state` from a workspace that did NOT install the App', () => {
  it('⚠️ reports `installed: true` and the organisation`s repositories — the defect, stated as what is now false', async () => {
    const state = await projectStateService.getProjectState(sibling.projectKey, sibling.ctx);

    // THIS IS THE REPRODUCTION. Before this card `findByWorkspaceId` answered
    // null from the sibling workspace, so `installed` was `false` and `index`
    // was empty — a confident, wrong `no` from the tool built to stop an agent
    // guessing.
    expect(state.code.installed).toBe(true);
    expect(state.code.index.repos).toEqual([
      { provider: 'github', repoRef: 'moooon/motir-ai', status: 'pending' },
      { provider: 'github', repoRef: 'moooon/motir-core', status: 'pending' },
    ]);
    expect(state.code.index.total).toBe(2);
  });

  it('⚠️ still answers a DIFFERENT question from `repoSet` — the tier moved, the question did not', async () => {
    // The distinction `tests/mcp/get-project-state.test.ts` pins: `code` is what
    // the TENANT has connected, `repoSet` is what THIS PROJECT planned. A
    // re-point of `code` at the project's set would have made both of these one
    // list and called that a fix.
    await claimForSiblingProject('motir-core');

    const state = await projectStateService.getProjectState(sibling.projectKey, sibling.ctx);

    expect(state.code.index.repos.map((r) => r.repoRef)).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
    ]);
    expect(state.repoSet.map((row) => row.realizedRepo?.repoRef)).toEqual(['moooon/motir-core']);
  });

  it('answers `installed: false` for an organisation that genuinely has no connection — the control', async () => {
    const bare = await makeOrgWithTwoWorkspaces('bare-4838@example.com');
    const project = await projectsService.createProject({
      workspaceId: bare.siblingWorkspaceId,
      actorUserId: bare.userId,
      name: 'Bare',
      identifier: 'BARE',
    });

    const state = await projectStateService.getProjectState(project.identifier, {
      userId: bare.userId,
      workspaceId: bare.siblingWorkspaceId,
    });

    expect(state.code.installed).toBe(false);
    expect(state.code.index.repos).toEqual([]);
  });

  it('the INSTALLING workspace reads the same set — the tier, not a redirection', async () => {
    // The no-regression half: the workspace the App was installed from saw these
    // repositories before this card and sees exactly them after it.
    const project = await projectsService.createProject({
      workspaceId: fx.installingWorkspaceId,
      actorUserId: fx.userId,
      name: 'Home',
      identifier: 'HOME',
    });

    const state = await projectStateService.getProjectState(project.identifier, {
      userId: fx.userId,
      workspaceId: fx.installingWorkspaceId,
    });

    expect(state.code.installed).toBe(true);
    expect(state.code.index.repos.map((r) => r.repoRef)).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
    ]);
  });

  it('another organisation`s connection never leaks in — the widening is one tier, not two', async () => {
    const other = await makeOrgWithTwoWorkspaces('other-state-4838@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: other.installingWorkspaceId,
      installation: {
        installationId: 'inst-4838-other-state',
        accountLogin: 'someone-else',
        accountType: 'Organization',
      },
      repos: [{ ...CORE, providerRepoId: '4838-other-state', owner: 'someone-else' }],
    });

    const state = await projectStateService.getProjectState(sibling.projectKey, sibling.ctx);

    expect(state.code.index.repos.every((r) => r.repoRef.startsWith('moooon/'))).toBe(true);
  });
});

// ── SITE 5 · `projectRepoEstablishService.getEstablishView` ──────────────────

describe('the establish step`s picker from a workspace that did NOT install the App', () => {
  it('⚠️ offers the ORGANISATION`s repositories, and still MARKS the ones this project claims', async () => {
    await claimForSiblingProject('motir-core');

    const view = await projectRepoEstablishService.getEstablishView(sibling.projectId, sibling.ctx);

    // THIS IS THE REPRODUCTION. Before this card `connectCandidates` was built
    // from `installation?.repos ?? []` with a null installation, so the picker
    // was EMPTY and the step read as "connect the App first".
    expect(view.hasInstallation).toBe(true);
    expect(view.connectCandidates.map((c) => c.repoRef).sort()).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
    ]);
    // The `claimed` marking is UNCHANGED — the picker marks rather than removes,
    // which is what keeps it from offering a choice that can only 409.
    expect(view.connectCandidates.find((c) => c.name === 'motir-core')?.claimed).toBe(true);
    expect(view.connectCandidates.find((c) => c.name === 'motir-ai')?.claimed).toBe(false);
  });

  it('another organisation`s connection never leaks in — the widening is one tier, not two', async () => {
    const other = await makeOrgWithTwoWorkspaces('other-4838@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: other.installingWorkspaceId,
      installation: {
        installationId: 'inst-4838-other',
        accountLogin: 'someone-else',
        accountType: 'Organization',
      },
      repos: [{ ...CORE, providerRepoId: '4838-other', owner: 'someone-else' }],
    });

    const view = await projectRepoEstablishService.getEstablishView(sibling.projectId, sibling.ctx);

    expect(view.connectCandidates.every((c) => c.owner === 'moooon')).toBe(true);
  });

  it('an organisation with no connection is still the honest empty state', async () => {
    const bare = await makeOrgWithTwoWorkspaces('bare-picker-4838@example.com');
    const project = await projectsService.createProject({
      workspaceId: bare.siblingWorkspaceId,
      actorUserId: bare.userId,
      name: 'Bare',
      identifier: 'BARE',
    });

    const view = await projectRepoEstablishService.getEstablishView(project.id, {
      userId: bare.userId,
      workspaceId: bare.siblingWorkspaceId,
    });

    expect(view.hasInstallation).toBe(false);
    expect(view.connectCandidates).toEqual([]);
  });
});
