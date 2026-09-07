import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { splitRoomSections, type OrgSectionEntry } from '@/lib/projectRepos/roomSections';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { defaultSeedSourceForRole } from '@/lib/projectRepos/vocabulary';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE TWO SURFACES, HELD SIDE BY SIDE — bug MOTIR-4820.
//
// ⚠️ THIS FILE EXISTS BECAUSE THE DEFECT IS INVISIBLE TO ANY TEST THAT RENDERS
// ONE PAGE. `/settings/organization/git` and `/settings/project/repositories`
// were each internally consistent and each fully covered by its own suite; the
// contradiction lived only in a reader who had seen both. So the assertion here
// is not about either page's output — it is about the RELATION between them, and
// it is the card's own acceptance criterion.
//
// The question both surfaces answer is one question:
//
//   ORG PAGE  · `Used by N projects`  — which projects use THIS repository?
//   ROOM      · `From your organisation` — which organisation repositories does
//                                          THIS project use?
//
// They are inverses of each other over the same relation, so for any project P
// and repository R: R is in P's org section ⟺ P is in R's `Used by` list. That
// biconditional is what is asserted below, in both directions, and it is what
// went false when MOTIR-4802 moved the org page onto the LADDER
// (`lib/projectRepos/effectiveDomain.ts`) and left the room keyed on
// `project_repository.seedSource`.
//
// ⚠️ AND THE DIRECTIONS ARE NOT REDUNDANT. The shipped defect broke exactly one
// of them: the org page named the project (⇐ held), the room's section was empty
// (⇒ failed). A test asserting only that the room's rows are "used by" this
// project passes on an EMPTY section, because the empty set satisfies it
// vacuously — which is how a one-directional check would have shipped green over
// this exact bug.
//
// Real Postgres. Nothing about the relation is stubbed; the only mock is the
// GitHub identity read, which is a network call and contributes nothing here.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;
let ctx: ServiceContext;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;
  ctx = { userId: fx.ownerId, workspaceId: fx.workspaceId };

  installationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'moooon',
        accountType: 'Organization',
        provider: 'github',
      },
    })
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedRepo(name: string) {
  return adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: `gh-${name}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
    },
  });
}

/**
 * WHAT THE ROOM DRAWS under `From your organisation`, as `owner/name` refs.
 *
 * Composed from exactly what the page composes — the room read plus the section
 * split — rather than re-derived, so a change to either is caught here.
 */
async function roomOrgSection(projectId: string): Promise<string[]> {
  const view = await projectRepoRoomService.getRoomView(projectId, ctx);
  const { fromOrganization } = splitRoomSections(view.rows, view.connected, view.connectedInDomain);
  return fromOrganization.map(entryRef).sort();
}

function entryRef(entry: OrgSectionEntry): string {
  if (entry.kind === 'domain') return entry.repo.repoRef;
  const realized = entry.row.realizedRepo;
  return realized ? `${realized.owner}/${realized.name}` : entry.row.name;
}

/** WHAT THE ORGANISATION'S INVENTORY says this project uses, as the same refs. */
async function inventorySaysUsedBy(projectId: string): Promise<string[]> {
  const usage = await organizationRepoService.listRepositoryUsage(ctx);
  return usage
    .filter((repo) => repo.projects.some((project) => project.id === projectId))
    .map((repo) => repo.repoRef)
    .sort();
}

/** A Motir-HOSTED row — the set's other half, which belongs to neither list. */
async function seedHostedRow(projectId: string, name: string) {
  return withWorkspaceContext(ctx, (tx) =>
    projectRepoRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId,
        role: 'api',
        name,
        seedSource: defaultSeedSourceForRole('api'),
        state: 'proposed',
        position: 'a0',
      },
      tx,
    ),
  );
}

describe('the room and the organisation inventory answer ONE question', () => {
  it('⚠️ THE DEFECT — a set-less project: the org page named it, the room drew nothing', async () => {
    // The shipped Motir project on the day this was filed, in miniature: no
    // repository SET, repositories connected to the organisation. The ladder
    // gives such a project the connected registry as its WHOLE domain, so the
    // inventory read `Used by Motir` for every row — while the room's
    // `From your organisation`, keyed on `project_repository.seedSource`, had
    // nothing to draw and drew an empty section directly above them.
    await seedRepo('motir-core');
    await seedRepo('motir-ai');

    const room = await roomOrgSection(fx.projectId);
    const inventory = await inventorySaysUsedBy(fx.projectId);

    expect(room).toEqual(['moooon/motir-ai', 'moooon/motir-core']);
    expect(inventory).toEqual(room);
  });

  it('agrees when the project PICKED a repository — the case that always worked', async () => {
    // A picked repository has a `project_repository` row, which is what the old
    // section was keyed on. It is asserted anyway: the fix must not trade one
    // half of the relation for the other.
    const repo = await seedRepo('motir-gateway');
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: repo.id, role: 'other' },
      ctx,
    );

    const room = await roomOrgSection(fx.projectId);
    expect(room).toEqual(['moooon/motir-gateway']);
    expect(await inventorySaysUsedBy(fx.projectId)).toEqual(room);
  });

  it('⚠️ agrees on a project the ladder does NOT layer — the section is ABSENT, not empty', async () => {
    // A project born in Motir is answered by its SET alone, so the workspace rung
    // is not part of its domain at all. Both surfaces must say so: the room draws
    // no organisation row, and the inventory must not name the project either.
    // This is the direction a fix that simply rendered `view.connected`
    // unconditionally would break — `connectedInDomain` is the ladder's own
    // boolean and is never a count.
    await seedRepo('motir-core');
    await seedHostedRow(fx.projectId, 'acme-api');

    expect(await roomOrgSection(fx.projectId)).toEqual([]);
    expect(await inventorySaysUsedBy(fx.projectId)).toEqual([]);
  });

  it('a MOTIR-HOSTED row belongs to neither list — it is the third thing on the page', async () => {
    // The hosted section is not part of this relation: Motir created that
    // repository, it has no `GithubRepo` of the organisation's behind it, and the
    // inventory has no row to count it on. Asserted so a future widening of the
    // org section cannot quietly swallow it.
    await seedRepo('motir-core');
    await seedHostedRow(fx.projectId, 'acme-api');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, ctx);
    const { motirHosted } = splitRoomSections(view.rows, view.connected, view.connectedInDomain);
    expect(motirHosted.map((row) => row.name)).toEqual(['acme-api']);
    expect(await inventorySaysUsedBy(fx.projectId)).not.toContain('acme-api');
  });

  it('⚠️ the biconditional holds per REPOSITORY, not only per project', async () => {
    // The inverse direction, stated as the inventory does: for every repository
    // the organisation has, the room shows it ⟺ the inventory names this project
    // against it. A section that over-reported would fail here while passing the
    // first case.
    await seedRepo('motir-core');
    await seedRepo('motir-ai');
    const room = new Set(await roomOrgSection(fx.projectId));

    for (const repo of await organizationRepoService.listRepositoryUsage(ctx)) {
      const inventoryNamesProject = repo.projects.some((p) => p.id === fx.projectId);
      expect(room.has(repo.repoRef)).toBe(inventoryNamesProject);
    }
  });
});
