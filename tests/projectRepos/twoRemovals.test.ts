import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateCodeGraphOffboarding } from '../helpers/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import {
  GithubRemovalHappensOnGithubError,
  MotirHostedRepoIsTakenOverError,
} from '@/lib/projectRepos/errors';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { OrgForbiddenError } from '@/lib/organizations/errors';
import { withSystemContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE TWO REMOVALS — one word, opposite blast radii
// Story MOTIR-4669 · subtask MOTIR-4679.
//
// | | remove from a PROJECT | disconnect from the ORGANISATION |
// |---|---|---|
// | links      | one row              | every project in the org, across workspaces |
// | code graph | NOTHING              | offboarded, `repo_disconnected`, WINDOWED    |
//
// ⚠️ TWO OF THESE ASSERTIONS ARE ABSENCES, and they are the ones worth the file.
// "Nothing was enqueued" and "the graph is still there" are invisible on a
// passing happy path: a project-level remove that quietly offboarded the
// organisation's graph would return 200 and look correct, and the damage would
// surface days later as a repository nobody can plan against. An absence is only
// ever proven by asserting it.
//
// Real Postgres throughout. The enqueue seam is SPIED rather than stubbed away —
// the org-level arm has to be seen to fire, so a blanket mock would make the two
// halves of this file untestable against each other.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;
let gitlabInstallationRowId: string;
let repoGithub: string;
let repoGitlab: string;
let enqueueSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  // `code_graph_offboarding` carries NO FK to workspace — deliberately, because
  // the row exists because the workspace was deleted — so a `TRUNCATE "workspace"
  // CASCADE` never reaches it and a pending row leaks into the next test. This
  // file both writes and counts those rows, so it must clear them itself.
  await truncateCodeGraphOffboarding();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;

  installationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-gh-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    })
  ).id;
  gitlabInstallationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-gl-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'gitlab',
      },
    })
  ).id;

  repoGithub = (await seedRepo(installationRowId, 'github', 'motir-core', 'gh-1')).id;
  repoGitlab = (await seedRepo(gitlabInstallationRowId, 'gitlab', 'motir-gateway', 'gl-1')).id;

  enqueueSpy = vi.spyOn(codeGraphOffboardingService, 'enqueueQuietly');
});

afterEach(() => {
  vi.restoreAllMocks();
  // `GITHUB_FALLBACK_ORG` is stubbed by the hosted-repository arm below and is
  // UNSET everywhere else — which is also the shipped default, so every other
  // assertion in this file runs against a deployment that hosts nothing.
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedRepo(
  installationId: string,
  provider: string,
  name: string,
  repoId: string,
  owner = 'moooon',
) {
  return adminDb.githubRepo.create({
    data: {
      installationId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId,
      owner,
      name,
      defaultBranch: 'main',
      provider,
      archived: false,
    },
  });
}

/** A SECOND workspace in the SAME organisation — the org-level arm is about what
 *  crosses a workspace boundary, so a one-workspace fixture cannot see it. */
async function secondWorkspaceInSameOrg(opts: { accessLevel?: 'open' | 'private' } = {}) {
  const ws = await adminDb.workspace.create({
    data: {
      organizationId: orgId,
      name: 'Second workspace',
      slug: `ws2-${Math.floor(Math.random() * 1_000_000)}`,
    },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: ws.id, userId: fx.ownerId, role: 'owner' },
  });
  const project = await createTestProject({
    workspaceId: ws.id,
    actorUserId: fx.ownerId,
    identifier: `SEC${Math.floor(Math.random() * 10_000)}`,
  });
  if (opts.accessLevel) {
    await adminDb.project.update({
      where: { id: project.id },
      data: { accessLevel: opts.accessLevel },
    });
  }
  const ctx: ServiceContext = { userId: fx.ownerId, workspaceId: ws.id };
  return {
    workspaceId: ws.id,
    projectId: project.id,
    projectName: project.name,
    ctx,
    // Enough of a `WorkItemFixture` for `createTestWorkItem`, which reads only
    // the ids, the identifier and the ctx — so `nameOnWork` below can seed work
    // in THIS workspace as well as in the main one.
    fx: {
      ...fx,
      workspace: ws,
      project,
      workspaceId: ws.id,
      projectId: project.id,
      projectIdentifier: project.identifier,
      ctx,
    } as WorkItemFixture,
  };
}

/**
 * NAME a repository on a project's WORK — the evidence the NAMED rung reads
 * (MOTIR-4821). This is what separates a project that has CHOSEN a repository
 * from one that merely MAY REACH it, and it is the only way a set-less project
 * can express the choice at all (`work_item.targetRepos`).
 *
 * Pinned through `adminDb` after the shipped create path has allocated the key
 * and position: the pin is a column this fixture only has to be present, and
 * routing it through the authoring service would drag the whole repo-domain
 * resolver into a test about a disclosure column.
 */
async function nameOnWork(target: { fx: WorkItemFixture }, repoName: string) {
  const item = await createTestWorkItem(target.fx, {
    // A root-level `task`, not a `subtask`: a subtask must have a parent, and the
    // pin is the only thing this fixture is about.
    kind: 'task',
    title: `work on ${repoName}`,
  });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { targetRepo: repoName, targetRepos: [repoName] },
  });
  return item;
}

/** The main fixture's project, in the shape `nameOnWork` takes. */
function mainProject() {
  return { fx };
}

/** Link a repository into a project through the shipped add path. */
async function link(projectId: string, githubRepoId: string, ctx: ServiceContext, name?: string) {
  return organizationRepoService.linkExistingRepo(
    projectId,
    { githubRepoId, role: 'api', ...(name ? { name } : {}) },
    ctx,
  );
}

describe('`Used by N projects` — ONE read, two consumers', () => {
  it('names the projects holding a repository across MORE THAN ONE workspace', async () => {
    const second = await secondWorkspaceInSameOrg();
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    const row = usage.find((u) => u.githubRepoId === repoGitlab);

    expect(row?.repoRef).toBe('moooon/motir-gateway');
    expect(row?.projects).toHaveLength(2);
    expect(new Set(row?.projects.map((p) => p.workspaceId))).toEqual(
      new Set([fx.workspaceId, second.workspaceId]),
    );
    // NAMES, not ids — the dialog enumerates them and the row's expansion shows
    // them, so a consumer must not have to do a second read to render either.
    expect(row?.projects.every((p) => p.name.length > 0)).toBe(true);
  });

  it('reports a repository NO project uses as an empty list — a legal state', async () => {
    // ⚠️ THE FIXTURE NOW HAS TO EARN THE ZERO (MOTIR-4802). It used to be the
    // bare fixture, and that was the DEFECT wearing a passing test: the project
    // has no repository SET, so the ladder's first rung makes every repository
    // connected in its workspace part of its domain, and a zero there was the
    // wrong answer rather than the legal state. Giving the project a set of its
    // own — a project BORN IN MOTIR — is what makes the connected registry stop
    // layering, and the zero real.
    await link(fx.projectId, repoGitlab, fx.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects).toEqual([]);
  });

  it('⚠️ the list is ACCESS-FILTERED — a project the viewer may not browse is not named', async () => {
    // The leak this read is shaped to avoid. The row's gate is org MEMBERSHIP
    // (organization-tier.md §6), and an organisation contains projects a given
    // member may not browse; naming one — or counting it — announces its
    // existence to someone with no access to it.
    const second = await secondWorkspaceInSameOrg({ accessLevel: 'private' });
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    // An org member who belongs to the FIRST workspace only.
    const outsider = await adminDb.user.create({
      data: {
        email: `out-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Outsider',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: outsider.id, role: 'member' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: outsider.id, role: ORGANIZATION_ROLE.member },
    });

    const usage = await organizationRepoService.listRepositoryUsage({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
    });
    const row = usage.find((u) => u.githubRepoId === repoGitlab);

    expect(row?.projects.map((p) => p.id)).toEqual([fx.projectId]);
    // …and THE COUNT IS THE LIST'S LENGTH. A `count: 2` beside one name would be
    // the same disclosure, arriving as a number instead of a word.
    expect(row?.projects).toHaveLength(1);
  });

  it('the OWNER sees both — so the filter above is the ACCESS, not the fixture', async () => {
    const second = await secondWorkspaceInSameOrg({ accessLevel: 'private' });
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(usage.find((u) => u.githubRepoId === repoGitlab)?.projects).toHaveLength(2);
  });
});

// ⚠️ "USES" IS WHAT A PROJECT HAS **CHOSEN** — MOTIR-4802 CORRECTED BY MOTIR-4821.
//
// The read shipped asking the LINK TABLE alone, and a repository a project WORKS
// ON need not have a link row, so on Motir's own project — six connected,
// indexed repositories, an empty set — EVERY inventory row read `Used by no
// project yet` (MOTIR-4802). The fix answered from the SCOPE LADDER instead, and
// the ladder is a permissive default: `effectiveDomain.ts`'s first rung hands a
// project with NO SET the whole connected registry precisely because it has never
// chosen. Read backwards that says every empty project uses every repository, and
// a scratch project created and left empty was duly named against all seven, on
// the disclosure a DESTRUCTIVE act rests on (MOTIR-4821).
//
// ⚠️ SO EVERY TEST IN THIS BLOCK THAT ASSERTS A SET-LESS PROJECT IS NAMED NOW
// SEEDS `nameOnWork` FIRST, AND THAT LINE IS THE FIX RATHER THAN FIXTURE
// PLUMBING. Without it these tests passed on the over-reporting predicate — they
// asserted that a project with a domain containing the repository is named, which
// is exactly the false claim. With it they assert the project NAMED the
// repository on its work, which is a choice. The two are indistinguishable on a
// fixture whose project has no work at all, which is why the defect shipped
// green.
//
// Each test below is one rung of that ladder, read from the other end. The
// `hasSet` cases are not decoration: they are what keeps the zero above a real
// state rather than a defect nobody notices.
describe('`Used by N projects` — CHOSEN, not merely reachable (MOTIR-4802 · MOTIR-4821)', () => {
  it('names a project whose repositories are CONNECTED and whose set is EMPTY — the reported defect', async () => {
    // The shipped Motir project's exact shape, at fixture scale: no repository
    // SET, and real work naming the repositories it is connected to.
    await nameOnWork(mainProject(), 'motir-core');
    await nameOnWork(mainProject(), 'motir-gateway');

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    for (const repoId of [repoGithub, repoGitlab]) {
      const row = usage.find((u) => u.githubRepoId === repoId);
      expect(row?.projects.map((p) => p.id)).toEqual([fx.projectId]);
    }
  });

  it('does NOT name a project BORN IN MOTIR for a repository its set never claimed', async () => {
    // The rung that makes the zero above legal: a set-holding project with no
    // code of its own is answered by its set ALONE, so the connected registry
    // stops layering and `repoGithub` is genuinely nobody's.
    await link(fx.projectId, repoGitlab, fx.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGitlab)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects).toEqual([]);
  });

  it('names a project that ARRIVED WITH CODE for both its set row and the connected registry', async () => {
    // The third rung — the set FIRST, connected UNDER it — so the project holds
    // the repository it linked AND the one its workspace is connected to.
    await link(fx.projectId, repoGitlab, fx.ctx);
    await nameOnWork(mainProject(), 'motir-core');
    await adminDb.migrateOnboarding.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'migrate',
        step: 'done',
        status: 'completed',
        connectedRepoRef: 'moooon/motir-core',
      },
    });

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGitlab)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
  });

  it('⚠️ layers a repository into its OWN workspace only — a sibling workspace`s project is NOT named', async () => {
    // `listConnectedRepoNames` is WORKSPACE-scoped, so the inverse must be too:
    // the org tier makes a repository PICKABLE from anywhere, not part of every
    // project's domain. A second workspace's set-less project layers ITS
    // workspace's registry — which here is empty — and holds nothing.
    const second = await secondWorkspaceInSameOrg();
    await nameOnWork(mainProject(), 'motir-core');
    // The sibling names it too — and is STILL not listed, because its workspace
    // is not the one the repository is connected in. A name on work is evidence
    // of a choice, never a way around the workspace scoping.
    await nameOnWork(second, 'motir-core');

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
    expect(
      usage.find((u) => u.githubRepoId === repoGithub)?.projects.map((p) => p.id),
    ).not.toContain(second.projectId);
  });

  it('…and an EXPLICIT link from that sibling workspace still counts — a link outranks the scoping', async () => {
    // The org tier's own claim, and the half the ladder must not eat: a project
    // may LINK a repository connected from a sibling workspace, and that link is
    // usage wherever it comes from.
    const second = await secondWorkspaceInSameOrg();
    await link(second.projectId, repoGithub, second.ctx);
    await nameOnWork(mainProject(), 'motir-core');

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    const row = usage.find((u) => u.githubRepoId === repoGithub);

    expect(new Set(row?.projects.map((p) => p.id))).toEqual(
      new Set([fx.projectId, second.projectId]),
    );
    // Once, not twice — a project that both layers and links a repository is one
    // name in the dialogue, not two.
    expect(row?.projects).toHaveLength(2);
  });

  it('⚠️ a LAYERED project is access-filtered exactly as a linked one is', async () => {
    // The disclosure rail has to hold on the new half too, or the fix trades a
    // wrong count for a leak. The second workspace's own connected repository
    // layers into its private project; an org member who is not in that
    // workspace must not be told the project exists.
    const second = await secondWorkspaceInSameOrg({ accessLevel: 'private' });
    const secondRepo = await adminDb.githubRepo.create({
      data: {
        installationId: installationRowId,
        workspaceId: second.workspaceId,
        organizationId: orgId,
        repoId: 'gh-2',
        owner: 'moooon',
        name: 'motir-ai',
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
      },
    });
    await nameOnWork(second, 'motir-ai');

    const outsider = await adminDb.user.create({
      data: {
        email: `out-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Outsider',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: outsider.id, role: 'member' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: outsider.id, role: ORGANIZATION_ROLE.member },
    });

    const asOutsider = await organizationRepoService.listRepositoryUsage({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
    });
    expect(asOutsider.find((u) => u.githubRepoId === secondRepo.id)?.projects).toEqual([]);

    // …and the owner, who IS in that workspace, sees it — so the empty above is
    // the ACCESS filter and not the ladder failing to reach a second workspace.
    const asOwner = await organizationRepoService.listRepositoryUsage(fx.ctx);
    expect(
      asOwner.find((u) => u.githubRepoId === secondRepo.id)?.projects.map((p) => p.id),
    ).toEqual([second.projectId]);
  });

  it('the INVENTORY row and the DISCONNECT dialogue read the same list — still one read', async () => {
    // `listInventory` composes `listRepositoryUsage`, and that composition is the
    // whole disclosure argument. The ladder must not have been added to one of
    // the two consumers.
    await nameOnWork(mainProject(), 'motir-core');

    const inventory = await organizationRepoService.listInventory(fx.ctx);
    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    for (const row of inventory) {
      expect(row.projects.map((p) => p.id)).toEqual(
        usage.find((u) => u.githubRepoId === row.repo.id)?.projects.map((p) => p.id),
      );
    }
    expect(inventory.find((r) => r.repo.id === repoGithub)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
  });
});

// ⚠️ THE OVER-REPORT — MOTIR-4821, the regression MOTIR-4802's fix introduced.
//
// The two projects below are IDENTICAL to the predicate that shipped: both sit in
// the connected workspace, both have NO repository set, so the ladder hands both
// the whole connected registry and the inventory named BOTH against every
// repository. One of them is the real project, working in the repository every
// day; the other is a scratch project somebody created and left empty. **They
// must come out DIFFERENT**, and no permissive default can separate them —
// which is why this is a predicate about EVIDENCE rather than about reach.
//
// This block fails on the shipped code in the direction that matters: the scratch
// project is NAMED there, on the disclosure the org-level disconnect dialogue
// leans on.
describe('`Used by N projects` does NOT name a project that never chose (MOTIR-4821)', () => {
  /** A second project in the SAME workspace, set-less exactly like the first. */
  async function scratchProject() {
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `SCR${Math.floor(Math.random() * 10_000)}`,
    });
    return {
      projectId: project.id,
      fx: {
        ...fx,
        project,
        projectId: project.id,
        projectIdentifier: project.identifier,
      } as WorkItemFixture,
    };
  }

  it('⚠️ THE REGRESSION: two set-less projects, one working in the repository and one empty, come out DIFFERENT', async () => {
    const scratch = await scratchProject();
    await nameOnWork(mainProject(), 'motir-core');

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);
    const row = usage.find((u) => u.githubRepoId === repoGithub);

    // Both are browsable, both layer the registry, and only one has chosen.
    expect(row?.projects.map((p) => p.id)).toEqual([fx.projectId]);
    expect(row?.projects.map((p) => p.id)).not.toContain(scratch.projectId);
  });

  it('a project that has NAMED NOTHING is named against NO repository — the scratch project', async () => {
    // The reporter's own tell: a project called `test`, created and left empty,
    // read as using all seven. Nothing it could have chosen exists, so every row
    // must be silent about it.
    const scratch = await scratchProject();

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    for (const row of usage) {
      expect(row.projects.map((p) => p.id)).not.toContain(scratch.projectId);
    }
  });

  it('the DISCONNECT dialogue inherits it — `listInventory` still composes the one read', async () => {
    // The column and the dialogue read the same list by construction, so the
    // over-report reached the destructive surface too. Asserting it HERE is what
    // stops a later change fixing the column and leaving the dialogue behind.
    const scratch = await scratchProject();
    await nameOnWork(mainProject(), 'motir-core');

    const inventory = await organizationRepoService.listInventory(fx.ctx);
    const row = inventory.find((r) => r.repo.id === repoGithub);

    expect(row?.projects.map((p) => p.id)).toEqual([fx.projectId]);
    expect(row?.projects.map((p) => p.id)).not.toContain(scratch.projectId);
  });

  it('matches the repository name case-insensitively and through the `owner/name` form', async () => {
    // `repoNameKey`'s rule, which `mergeDomainsByName` already applies within the
    // domain: two spellings that differ only in case, or a ref carrying its owner,
    // name ONE checkout. A pin copied out of the GitHub surface arrives as
    // `owner/name`, and it is a choice however it is spelled.
    await nameOnWork(mainProject(), 'moooon/Motir-Core');

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
  });

  it('reads the `targetRepo` SCALAR too — a row written before the array existed still counts', async () => {
    // `targetRepo` IS `targetRepos[0]` for anything written since the array
    // landed, but a legacy row carries only the scalar. Dropping it would leave a
    // project silently missing from a disconnect dialogue, which is the same
    // failure this card is about, pointed the other way.
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'legacy pin' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { targetRepo: 'motir-core', targetRepos: [] },
    });

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects.map((p) => p.id)).toEqual([
      fx.projectId,
    ]);
  });

  it('a project that LINKED the repository is named even with no work at all — the link IS the choice', async () => {
    // The EXPLICIT half must not be narrowed by the NAMED one. Picking a
    // repository through `Add repository` (MOTIR-4678) is a choice already made,
    // and a project that has linked one and not started yet still loses it.
    const scratch = await scratchProject();
    await link(scratch.projectId, repoGithub, fx.ctx);

    const usage = await organizationRepoService.listRepositoryUsage(fx.ctx);

    expect(usage.find((u) => u.githubRepoId === repoGithub)?.projects.map((p) => p.id)).toEqual([
      scratch.projectId,
    ]);
  });
});

describe('REMOVE FROM A PROJECT — and it must do almost nothing', () => {
  it('deletes exactly one row and enqueues NOTHING', async () => {
    const second = await secondWorkspaceInSameOrg();
    const mine = await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);
    enqueueSpy.mockClear();

    await projectRepoSetService.removeRow(mine.id, fx.ctx);

    expect(await adminDb.projectRepo.count({ where: { projectId: fx.projectId } })).toBe(0);
    // THE assertion. A project-level remove that offboarded would look identical
    // from the outside and cost the organisation its graph.
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('leaves the organisation`s connection, the mirror row, and the OTHER projects untouched', async () => {
    const second = await secondWorkspaceInSameOrg();
    const mine = await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);

    await projectRepoSetService.removeRow(mine.id, fx.ctx);

    // the mirror row — the organisation's connection
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGitlab } })).not.toBeNull();
    // …and the other project's link, unchanged
    const others = await adminDb.projectRepo.findMany({ where: { projectId: second.projectId } });
    expect(others).toHaveLength(1);
    expect(others[0]?.githubRepoId).toBe(repoGitlab);
    // …and no pending offboarding anywhere
    expect(await adminDb.codeGraphOffboarding.count()).toBe(0);
  });

  it('⚠️ removing the LAST project`s link leaves the repository in the inventory, indexed', async () => {
    // The case the wrong optimisation targets, asserted BY NAME so nobody has to
    // infer that it was considered. "Nothing uses it any more, so drop the graph"
    // re-introduces per-project ownership through the back door and makes the
    // next project that adds it pay for a full re-index.
    const only = await link(fx.projectId, repoGitlab, fx.ctx);
    enqueueSpy.mockClear();

    await projectRepoSetService.removeRow(only.id, fx.ctx);

    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGitlab } })).not.toBeNull();
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(await adminDb.codeGraphOffboarding.count()).toBe(0);

    // …and it is offered back to the same project, at no cost.
    const options = await organizationRepoService.listAvailableForProject(fx.projectId, fx.ctx);
    expect(options.map((o) => o.id)).toContain(repoGitlab);
  });
});

describe('DISCONNECT FROM THE ORGANISATION — the cascade', () => {
  it('clears every project`s link ACROSS workspaces and enqueues one windowed offboarding', async () => {
    const second = await secondWorkspaceInSameOrg();
    await link(fx.projectId, repoGitlab, fx.ctx);
    await link(second.projectId, repoGitlab, second.ctx);
    enqueueSpy.mockClear();

    const result = await organizationRepoService.disconnectFromOrganisation(repoGitlab, fx.ctx);

    expect(result.clearedLinks).toBe(2);

    // Every project lost the repository — in BOTH workspaces.
    const rows = await adminDb.projectRepo.findMany({
      where: { projectId: { in: [fx.projectId, second.projectId] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.githubRepoId === null)).toBe(true);

    // The mirror row is gone…
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGitlab } })).toBeNull();

    // …and the offboarding is enqueued with the REASON that makes it windowed.
    const reasons = enqueueSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { reason: string }).reason,
    );
    expect(new Set(reasons)).toEqual(new Set(['repo_disconnected']));

    const pending = await withSystemContext((tx) => tx.codeGraphOffboarding.findMany());
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.reason === 'repo_disconnected')).toBe(true);
    expect(new Set(pending.map((p) => p.repoRef))).toEqual(new Set(['moooon/motir-gateway']));
  });

  it('the removal is WINDOWED, not immediate — `dueAt` is the retention window away', async () => {
    // What makes the promise in the copy true. An immediate purge would bill a
    // user for their own misclick, because a re-index is a metered container per
    // (repo × project).
    await link(fx.projectId, repoGitlab, fx.ctx);
    const before = Date.now();
    await organizationRepoService.disconnectFromOrganisation(repoGitlab, fx.ctx);

    const [row] = await withSystemContext((tx) => tx.codeGraphOffboarding.findMany());
    const windowMs = CODE_GRAPH_RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(row!.dueAt.getTime()).toBeGreaterThan(before + windowMs - 60_000);
  });

  it('⚠️ REFUSES a GitHub repository — Motir cannot remove one, and must not pretend to', async () => {
    // Not a permission refusal. Selection is the App's install screen; a
    // Motir-side "stop tracking" would delete the mirror row while leaving the
    // grant in place, and the repository would reappear on the next reconcile.
    await link(fx.projectId, repoGithub, fx.ctx);
    enqueueSpy.mockClear();

    await expect(
      organizationRepoService.disconnectFromOrganisation(repoGithub, fx.ctx),
    ).rejects.toBeInstanceOf(GithubRemovalHappensOnGithubError);

    // Refused means untouched — the mirror row, the link, and the queue.
    expect(await adminDb.githubRepo.findUnique({ where: { id: repoGithub } })).not.toBeNull();
    const [row] = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(row?.githubRepoId).toBe(repoGithub);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('⚠️ REFUSES a repository MOTIR HOSTS, and names the TAKEOVER as the act (bug MOTIR-4892)', async () => {
    // ⚠️ THE ORDER IS THE FIX, so the assertion is about WHICH refusal arrives.
    // `GithubRemovalHappensOnGithubError` is thrown for EVERY `github` row before
    // any ownership test, and its instruction — *change the Motir App's repository
    // access on GitHub* — points at the ORGANISATION's own installation. A
    // repository under the provisioning organisation is not in that installation:
    // it sits under the SHARED provisioning one, which is `organizationId: null`
    // because it spans tenants. So the refusal that existed was about the PROVIDER
    // and the one that was owed is about the OWNER.
    //
    // Asserted on the SERVICE, deliberately — the surface withholds the control
    // (`organizationGitPage.test.tsx`), and this is the half that holds for a
    // caller that never rendered the page.
    //
    // The env value's casing deliberately differs from the row's: a GitHub login
    // is case-insensitive and `GITHUB_FALLBACK_ORG` is whatever an operator typed.
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'Motir-Projects');
    const hosted = await seedRepo(
      installationRowId,
      'github',
      'motir',
      'gh-hosted',
      'motir-projects',
    );
    await link(fx.projectId, hosted.id, fx.ctx, 'hosted');
    enqueueSpy.mockClear();

    const err = await organizationRepoService.disconnectFromOrganisation(hosted.id, fx.ctx).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MotirHostedRepoIsTakenOverError);
    expect(err).not.toBeInstanceOf(GithubRemovalHappensOnGithubError);
    expect((err as MotirHostedRepoIsTakenOverError).code).toBe('MOTIR_HOSTED_REPO_IS_TAKEN_OVER');
    // It names the act that DOES apply — the takeover (MOTIR-711) — rather than
    // sending the reader to an installation the repository is not in.
    expect((err as Error).message).toMatch(/take it over/i);
    expect((err as Error).message).not.toMatch(/App's repository access/i);

    // Refused means untouched — the mirror row, the link, and the queue.
    expect(await adminDb.githubRepo.findUnique({ where: { id: hosted.id } })).not.toBeNull();
    const rows = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(rows.some((r) => r.githubRepoId === hosted.id)).toBe(true);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('⚠️ classifies NOTHING with no provisioning org configured — the refusal is byte-for-byte today`s', async () => {
    // The null-safe arm. A deployment that cannot provision (self-hosted, no
    // `GITHUB_FALLBACK_ORG`) hosts nothing, so the SAME row that is refused above
    // falls through to the provider refusal exactly as it did before this rule
    // existed. Asserted so the new gate cannot silently widen.
    const hosted = await seedRepo(
      installationRowId,
      'github',
      'motir',
      'gh-hosted-2',
      'motir-projects',
    );
    await link(fx.projectId, hosted.id, fx.ctx, 'hosted-2');

    await expect(
      organizationRepoService.disconnectFromOrganisation(hosted.id, fx.ctx),
    ).rejects.toBeInstanceOf(GithubRemovalHappensOnGithubError);
  });

  it('is ORG-ADMIN — a plain org member is refused and nothing is cleared', async () => {
    const member = await adminDb.user.create({
      data: {
        email: `m-${Math.floor(Math.random() * 1_000_000)}@example.com`,
        name: 'Member',
        emailVerified: true,
      },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: member.id, role: 'admin' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: member.id, role: ORGANIZATION_ROLE.member },
    });
    await link(fx.projectId, repoGitlab, fx.ctx);
    enqueueSpy.mockClear();

    await expect(
      organizationRepoService.disconnectFromOrganisation(repoGitlab, {
        userId: member.id,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    const [row] = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(row?.githubRepoId).toBe(repoGitlab);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe('the GITHUB arm arrives through the WEBHOOK, not through Motir', () => {
  it('a repository dropped from the SELECTION is pruned and enqueued by the reconcile', async () => {
    // The shipped `installation_repositories` path, driven directly. This is what
    // the refusal above defers TO, and asserting it is what makes the refusal a
    // routing decision rather than a missing feature.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `inst-gh-${fx.workspaceId}`,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: 'gh-1',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    enqueueSpy.mockClear();

    // The next delivery selects NOTHING — the user de-selected it on GitHub.
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `inst-gh-${fx.workspaceId}`,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [],
    });

    // The mirror row is gone, and the graph is queued with the SAME reason the
    // org-level arm uses — one vocabulary, two doors.
    expect(await adminDb.githubRepo.findFirst({ where: { repoId: 'gh-1' } })).toBeNull();
    const pending = await withSystemContext((tx) => tx.codeGraphOffboarding.findMany());
    expect(pending.map((p) => p.reason)).toEqual(['repo_disconnected']);
  });
});

describe('the retention window is INTERPOLATED, never retyped', () => {
  // `lib/codeGraph/offboarding.ts` states the rule on itself: one named constant,
  // interpolated into the copy that states it, "so the promise and the behaviour
  // cannot drift." A product that says 30 days in a dialog and enforces something
  // else has expressed its enforcement in terms it does not control.
  const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as Record<string, unknown>;
  const github = (en['github'] as Record<string, Record<string, string>>) ?? {};

  it('every retention string this story adds carries `{days}`', () => {
    expect(github['orgDisconnect']?.['codeIndex']).toContain('{days}');
  });

  it('NO retention string hard-codes the number', () => {
    const strings = [
      ...Object.values(github['orgDisconnect'] ?? {}),
      ...Object.values(github['projectRemove'] ?? {}),
      github['repos']?.['codeIndex'] ?? '',
    ];
    const hardCoded = strings.filter((s) =>
      new RegExp(`\\b${CODE_GRAPH_RETENTION_WINDOW_DAYS}\\b`).test(s),
    );
    expect(hardCoded, 'interpolate CODE_GRAPH_RETENTION_WINDOW_DAYS as {days}').toEqual([]);
  });

  it('the PROJECT-level copy promises the opposite, and says so', () => {
    // The two removals share a word; their copy must not. This one REASSURES —
    // it is the only place in the product where "removes" is the harmless act.
    const body = github['projectRemove']?.['body'] ?? '';
    expect(body).toContain('only');
    expect(body).toContain('code index is untouched');
    expect(body).not.toContain('{days}');
  });
});
