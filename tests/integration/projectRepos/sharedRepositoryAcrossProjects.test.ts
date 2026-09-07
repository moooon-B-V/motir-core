import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces';

// A REPOSITORY IN TWO PROJECTS IS THE ORDINARY CASE
// Story MOTIR-4669 · subtask MOTIR-4648.
//
// `ProjectRepo.githubRepoId` was `@unique`. The schema comment said why: *"a
// realized repo is claimed by AT MOST ONE project row, so a repo created for
// project A can never be recorded as project B's."* A repository belongs to the
// ORGANISATION now, and which projects use it is visibility configuration — so
// that sentence is not relaxed, it is FALSE, and until this card the situation
// was **inexpressible**: a single unique index made it impossible to create,
// which is why nothing downstream ever had to answer what it would mean.
//
// What this suite owns is therefore both halves, because dropping the index
// alone would remove a CAPABILITY rather than a concept:
//
//   1. the situation is now expressible, and
//   2. the guarantee that SURVIVED is still enforced — by the DATABASE, not by
//      application code — namely one repository at most once per project.
//
// Real Postgres, real repository layer, no mocks.

let fx: WorkItemFixture;
let secondProjectId: string;
let repoId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();

  // A SECOND project in the same workspace — the whole point is that both may
  // hold a row realizing one repository.
  const second = await adminDb.project.create({
    data: {
      workspaceId: fx.workspaceId,
      name: 'Second project',
      slug: `second-${Math.floor(Math.random() * 1_000_000)}`,
      identifier: `SEC${Math.floor(Math.random() * 10_000)}`,
    },
  });
  secondProjectId = second.id;

  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-shared-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-shared-${fx.workspaceId}`,
      owner: 'moooon',
      name: 'shared-repo',
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
    },
  });
  repoId = repo.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A `project_repository` row realizing `repoId`, written through the admin
 *  client so the test states the DATABASE's answer rather than a service's. */
function row(projectId: string, name: string, githubRepoId: string | null, position: string) {
  return adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId,
      role: 'api',
      name,
      seedSource: 'starter',
      state: githubRepoId ? 'connected' : 'proposed',
      position,
      ...(githubRepoId ? { githubRepoId } : {}),
    },
  });
}

describe('two projects can each realize the SAME repository', () => {
  it('accepts a row in each project and reads both sets back', async () => {
    // The situation the dropped index made impossible to create.
    const a = await row(fx.projectId, 'shared-repo', repoId, 'a0');
    const b = await row(secondProjectId, 'shared-repo', repoId, 'a0');

    expect(a.githubRepoId).toBe(repoId);
    expect(b.githubRepoId).toBe(repoId);

    const setA = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    const setB = await adminDb.projectRepo.findMany({ where: { projectId: secondProjectId } });
    expect(setA.map((r) => r.githubRepoId)).toEqual([repoId]);
    expect(setB.map((r) => r.githubRepoId)).toEqual([repoId]);
  });

  it('the back-relation is a LIST and names both rows', async () => {
    await row(fx.projectId, 'shared-repo', repoId, 'a0');
    await row(secondProjectId, 'shared-repo', repoId, 'a0');

    const repo = await adminDb.githubRepo.findUniqueOrThrow({
      where: { id: repoId },
      include: { projectRepos: true },
    });
    // `GithubRepo.projectRepo` was `ProjectRepo?`. A singular relation here would
    // not merely be a naming choice — it would silently drop one of the two.
    expect(repo.projectRepos).toHaveLength(2);
    expect(new Set(repo.projectRepos.map((r) => r.projectId))).toEqual(
      new Set([fx.projectId, secondProjectId]),
    );
  });
});

describe('the guarantee that SURVIVED — one repository, at most once per project', () => {
  it('REFUSES a second row realizing the same repository in the SAME project', async () => {
    await row(fx.projectId, 'shared-repo', repoId, 'a0');
    // Enforced by `@@unique([projectId, githubRepoId])` — in the database, so a
    // concurrent write cannot slip past it the way an application check can.
    await expect(row(fx.projectId, 'shared-repo-again', repoId, 'a1')).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('still allows MANY unrealized rows per project — NULLs claim nothing', async () => {
    await row(fx.projectId, 'planned-one', null, 'a0');
    await row(fx.projectId, 'planned-two', null, 'a1');
    const rows = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.githubRepoId === null)).toBe(true);
  });
});

describe('the reads that replaced findByGithubRepoId', () => {
  // The old method was `findFirst({ where: { githubRepoId } })` and it was total
  // only because the index made it so. It is gone; these two are what the four
  // call sites took instead, and the difference between them is the whole
  // disposition each call site had to make.

  it('findByProjectAndGithubRepoId — the CLAIM guard, scoped to one project', async () => {
    const mine = await row(fx.projectId, 'shared-repo', repoId, 'a0');
    await row(secondProjectId, 'shared-repo', repoId, 'a0');

    const inMine = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => projectRepoRepository.findByProjectAndGithubRepoId(fx.projectId, repoId, tx),
    );
    expect(inMine?.id).toBe(mine.id);

    // A project that does NOT have it reads null — which is what makes the 409
    // mean "already in THIS project" rather than "claimed by somebody".
    const third = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Third project',
        slug: `third-${Math.floor(Math.random() * 1_000_000)}`,
        identifier: `THR${Math.floor(Math.random() * 10_000)}`,
      },
    });
    const inThird = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => projectRepoRepository.findByProjectAndGithubRepoId(third.id, repoId, tx),
    );
    expect(inThird).toBeNull();
  });

  it('listByGithubRepoId — the SET, so a caller has to decide what TWO means', async () => {
    await row(fx.projectId, 'shared-repo', repoId, 'a0');
    await row(secondProjectId, 'shared-repo', repoId, 'a0');

    const all = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => projectRepoRepository.listByGithubRepoId(repoId, tx),
    );
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.projectId))).toEqual(new Set([fx.projectId, secondProjectId]));
  });

  it('no call site is left on a bare findFirst over githubRepoId', async () => {
    // The method that would return AN answer rather than THE answer is gone, and
    // this asserts it stayed gone — a re-introduction is a silent regression
    // everywhere, because it type-checks and returns a plausible row.
    expect('findByGithubRepoId' in projectRepoRepository).toBe(false);
  });
});
