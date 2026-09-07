import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
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
// contradiction lived only in a reader who had seen both. So what is asserted
// here is not either page's output — it is the RELATION between them, which is
// the card's own acceptance criterion.
//
// ── ⚠️ WHAT THE RELATION IS, AND WHAT IT IS NOT (AMENDED 2026-09-07) ─────────
// This file first asserted the two surfaces answer the SAME question — a
// biconditional, `R ∈ P`'s org section ⟺ `P ∈ R`'s `Used by` list. **That was
// true for about four hours and it was never the product's invariant.** It held
// only between MOTIR-4802, which moved `Used by` onto the scope ladder, and
// MOTIR-4821 (merged `feebd806c`, 2026-09-07 14:10Z), which moved it off again:
//
//   ROOM      · `From your organisation` — what this project can REACH. The
//              LADDER (`lib/projectRepos/effectiveDomain.ts`), unchanged by
//              MOTIR-4821.
//   ORG PAGE  · `Used by N projects`     — what a project has CHOSEN: an explicit
//              `project_repository` link, or a repository its work NAMES
//              (`work_item.targetRepos`).
//
// **The two are deliberately different questions now, and the relation between
// them is a CONTAINMENT plus a DISCLOSURE**: choosing implies reaching, the gap
// is real, and MOTIR-4821 discloses the gap in words on the org surface —
// *"Any project here that has no repositories of its own can also reach the ones
// connected in its workspace, whether or not it is named above."* That sentence
// is what makes the two pages holdable in one head, so it is LOAD-BEARING for
// MOTIR-4820's surface and is asserted here rather than left to the org page's
// own suite. Delete it and the contradiction this card is about comes back.
//
// ⚠️ ASSERTING THE OLD BICONDITIONAL WOULD NOW PIN A COINCIDENCE. It would go red
// on the shipped product, and it would go red again on any future correct change
// to either question. A test that pins the overlap of two independent answers
// fails whenever either one is right.
//
// Real Postgres. Nothing about the relation is stubbed.

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

/** WHAT THE ORGANISATION'S INVENTORY says this project has CHOSEN, same refs. */
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

/** The one way a SET-LESS project can express a choice: work that NAMES a
 *  repository (`work_item.targetRepos` — MOTIR-4821's second rung). */
async function nameRepoOnWork(repoName: string) {
  const item = await createTestWorkItem(fx, { kind: 'task', title: `work on ${repoName}` });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { targetRepo: repoName, targetRepos: [repoName] },
  });
}

describe('the room and the organisation inventory — CONTAINMENT, not equality', () => {
  it('⚠️ THE DEFECT — a set-less project REACHES its organisation`s repositories, and the room says so', async () => {
    // The shipped Motir project on the day this was filed, in miniature: no
    // repository SET, repositories connected to the organisation. The ladder
    // gives such a project the connected registry as its WHOLE domain — and the
    // room's `From your organisation`, keyed on `project_repository.seedSource`,
    // had nothing to draw and drew an EMPTY section directly above them.
    //
    // This is the assertion that fails against the shipped room, and it does not
    // depend on what the org page counts.
    await seedRepo('motir-core');
    await seedRepo('motir-ai');

    expect(await roomOrgSection(fx.projectId)).toEqual(['moooon/motir-ai', 'moooon/motir-core']);
  });

  it('⚠️ CHOOSING IMPLIES REACHING — the NAMED rung, on a set-less project', async () => {
    // The containment, and the direction that is a real invariant: the org page
    // may legitimately name FEWER projects than can reach a repository, and may
    // never name one that CANNOT. A project shown a repository it may not use is
    // the failure this catches, and it is the one a future change to either
    // question can still introduce.
    //
    // Work that NAMES a repository is the ONLY way a set-less project can express
    // a choice (MOTIR-4821's second rung), so this is also the one fixture where
    // the containment is PROPER: two reachable, one chosen.
    await seedRepo('motir-core');
    await seedRepo('motir-ai');
    await nameRepoOnWork('motir-core');

    const room = new Set(await roomOrgSection(fx.projectId));
    const chosen = await inventorySaysUsedBy(fx.projectId);

    expect(chosen).toEqual(['moooon/motir-core']);
    expect([...room].sort()).toEqual(['moooon/motir-ai', 'moooon/motir-core']);
    for (const ref of chosen) expect(room.has(ref)).toBe(true);
  });

  it('⚠️ CHOOSING IMPLIES REACHING — the LINK rung, which also SETTLES the domain', async () => {
    // The other rung, and the case that shows why the two questions cannot simply
    // be made equal: linking a repository gives the project a SET, and a set
    // without code of its own is answered by the set ALONE. So the act that puts
    // the project on the org page is the same act that narrows what its room
    // shows — the containment holds, and here it is tight rather than proper.
    const linked = await seedRepo('motir-gateway');
    await seedRepo('motir-core');
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: linked.id, role: 'other' },
      ctx,
    );

    const room = new Set(await roomOrgSection(fx.projectId));
    const chosen = await inventorySaysUsedBy(fx.projectId);

    expect(chosen).toEqual(['moooon/motir-gateway']);
    expect([...room]).toEqual(['moooon/motir-gateway']);
    for (const ref of chosen) expect(room.has(ref)).toBe(true);
  });

  it('⚠️ THE GAP IS REAL AND DELIBERATE — reaching does NOT imply choosing', async () => {
    // MOTIR-4821's whole point: a set-less project that has chosen nothing must
    // not be named on the disclosure a DESTRUCTIVE act rests on. So the room is
    // populated and the inventory names the project against nothing, and that is
    // the product being right rather than the two pages disagreeing.
    await seedRepo('motir-core');
    await seedRepo('motir-ai');

    expect((await roomOrgSection(fx.projectId)).length).toBe(2);
    expect(await inventorySaysUsedBy(fx.projectId)).toEqual([]);
  });

  it('⚠️ AND THE GAP IS DISCLOSED — the sentence that makes both pages holdable at once', async () => {
    // The other half of the pairing, and the reason this assertion lives in THIS
    // file rather than in the org page's own suite: MOTIR-4820 is a bug about a
    // reader holding two surfaces in one head, and after MOTIR-4821 the thing
    // that lets them is a sentence on the org surface. It is load-bearing for
    // this card, so it is pinned where this card's reader will look.
    const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as Record<string, never>;
    const github = (en as unknown as { github: Record<string, Record<string, string>> }).github;

    expect(github.inventory!.foot).toContain('no repositories of its own can also reach');
    expect(github.orgDisconnect!.alsoReachable).toContain(
      'no repositories of its own can also reach',
    );
  });

  it('agrees on a project the ladder does NOT layer — BOTH surfaces say nothing', async () => {
    // A project born in Motir is answered by its SET alone, so the workspace rung
    // is not part of its domain at all. The room draws no organisation section,
    // and the inventory names the project against nothing either — the one shape
    // where the two questions still coincide, and the direction a fix that
    // rendered `view.connected` unconditionally would break.
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
});
