import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { resolveItemDispatchRepo } from '@/lib/workItems/dispatchRepo';
import { ConflictingTargetRepoInputError, UnknownTargetRepoError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The repository SET through the real write path, over real Postgres (Story
// MOTIR-2725 · MOTIR-2727, ADR `docs/decisions/work-item-repository-set.md`).
//
// The unit file beside this one pins the POLICY without a work item. This one
// pins the three things only a row can answer:
//
//   1. The set ROUND-TRIPS through create and update, and the derived scalar
//      never describes a different repository than element 0.
//   2. The MIGRATION's backfill turns a pre-existing pin into a one-element set —
//      driven with the migration's OWN SQL, read off disk, so the assertion and
//      the shipped statement cannot drift.
//   3. DISPATCH is unchanged for every shape of row the migration can leave
//      behind — pinned, role-pinned, and unpinned.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

/** Connect one repo to the fixture's workspace — the registry a pin validates
 *  against (the 7.10.3 installation mirror). */
async function connectRepo(fx: WorkItemFixture, name: string, defaultBranch = 'main') {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-github` },
    create: {
      installationId: `inst-${fx.workspaceId}-github`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch,
      archived: false,
      provider: 'github',
    },
  });
}

async function row(id: string) {
  const found = await adminDb.workItem.findUnique({
    where: { id },
    select: { targetRepo: true, targetRepos: true },
  });
  if (!found) throw new Error(`work item ${id} vanished`);
  return found;
}

describe('the SET on the write path — create', () => {
  it('stores a two-element set and derives the scalar from element 0', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai', 'trunk');

    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'A card that ships in two repositories',
        assigneeId: null,
        descriptionMd: null,
        targetRepos: ['motir-ai', 'motir-core'],
      },
      fx.ctx,
    );

    expect(await row(created.id)).toMatchObject({
      targetRepos: ['motir-ai', 'motir-core'],
      // The scalar is the PRIMARY, not "the first one anybody happened to type"
      // — it is what dispatch routes to, asserted below.
      targetRepo: 'motir-ai',
    });
  });

  it('turns a caller that only knows the SCALAR into a valid one-element set', async () => {
    // Every shipped caller sends this shape. It is what makes MOTIR-2728's
    // surfaces additive rather than a flag day.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'One repo, the old way',
        assigneeId: null,
        descriptionMd: null,
        targetRepo: 'moooon/motir-core',
      },
      fx.ctx,
    );
    expect(await row(created.id)).toMatchObject({
      targetRepo: 'motir-core',
      targetRepos: ['motir-core'],
    });
  });

  it('leaves an unpinned card with the EMPTY set — the same state a null pin has always meant', async () => {
    const fx = await makeWorkItemFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unpinned', assigneeId: null },
      fx.ctx,
    );
    expect(await row(created.id)).toMatchObject({ targetRepo: null, targetRepos: [] });
  });

  it('rejects an unknown element with the shipped typed error, and writes NOTHING', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Half-valid',
          assigneeId: null,
          targetRepos: ['motir-core', 'motir-typo'],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(UnknownTargetRepoError);
    // Validated BEFORE the key-allocation transaction, so a rejected set never
    // burns a work-item key either.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });

  it('rejects a write that supplies BOTH fields (ADR §3.4) rather than picking a winner', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Both fields',
          assigneeId: null,
          targetRepo: 'motir-core',
          targetRepos: ['motir-ai'],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(ConflictingTargetRepoInputError);
  });

  it('rejects both fields even when the scalar is a CLEAR — null still describes the field', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Clear plus set',
          assigneeId: null,
          targetRepo: null,
          targetRepos: ['motir-core'],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(ConflictingTargetRepoInputError);
  });
});

describe('the SET on the write path — update', () => {
  async function pinned(fx: WorkItemFixture, repos: string[]) {
    return workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: `Card ${randomToken(4)}`,
        assigneeId: null,
        targetRepos: repos,
      },
      fx.ctx,
    );
  }

  it('replaces the set wholesale and moves the scalar with it', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await pinned(fx, ['motir-core']);

    await workItemsService.updateWorkItem(
      item.id,
      { targetRepos: ['motir-ai', 'motir-core'] },
      fx.ctx,
    );
    expect(await row(item.id)).toMatchObject({
      targetRepos: ['motir-ai', 'motir-core'],
      targetRepo: 'motir-ai',
    });
  });

  it('treats a REORDER as a real change, because it moves where an agent runs', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await pinned(fx, ['motir-core', 'motir-ai']);

    await workItemsService.updateWorkItem(
      item.id,
      { targetRepos: ['motir-ai', 'motir-core'] },
      fx.ctx,
    );
    expect(await row(item.id)).toMatchObject({
      targetRepos: ['motir-ai', 'motir-core'],
      targetRepo: 'motir-ai',
    });
  });

  it('clears the set with [], leaving the same state an unpinned card has', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await pinned(fx, ['motir-core']);
    await workItemsService.updateWorkItem(item.id, { targetRepos: [] }, fx.ctx);
    expect(await row(item.id)).toMatchObject({ targetRepos: [], targetRepo: null });
  });

  it('keeps the patch surface no looser than create — unknown element, both-fields, same errors', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await pinned(fx, ['motir-core']);

    await expect(
      workItemsService.updateWorkItem(item.id, { targetRepos: ['motir-typo'] }, fx.ctx),
    ).rejects.toThrow(UnknownTargetRepoError);
    await expect(
      workItemsService.updateWorkItem(
        item.id,
        { targetRepo: 'motir-core', targetRepos: ['motir-core'] },
        fx.ctx,
      ),
    ).rejects.toThrow(ConflictingTargetRepoInputError);
    // Neither rejection moved the row.
    expect(await row(item.id)).toMatchObject({
      targetRepos: ['motir-core'],
      targetRepo: 'motir-core',
    });
  });

  it('keeps the SCALAR patch working, and keeps the two columns in step', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await pinned(fx, ['motir-core', 'motir-ai']);

    // A caller that knows only the old field REPLACES the set with the
    // one-element set it means. It cannot leave the scalar and the list
    // describing different repositories, which is the failure this asserts away.
    await workItemsService.updateWorkItem(item.id, { targetRepo: 'motir-ai' }, fx.ctx);
    expect(await row(item.id)).toMatchObject({
      targetRepo: 'motir-ai',
      targetRepos: ['motir-ai'],
    });
  });

  it('records the set change in the revision diff alongside the primary', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await pinned(fx, ['motir-core']);
    await workItemsService.updateWorkItem(
      item.id,
      { targetRepos: ['motir-ai', 'motir-core'] },
      fx.ctx,
    );

    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: item.id },
      orderBy: { changedAt: 'desc' },
      take: 1,
    });
    expect(revisions[0]?.diff).toMatchObject({
      targetRepos: { from: ['motir-core'], to: ['motir-ai', 'motir-core'] },
      targetRepo: { from: 'motir-core', to: 'motir-ai' },
    });
  });
});

describe("the MIGRATION's backfill — driven with the shipped statement itself", () => {
  /** The `UPDATE` this migration ships, read off disk so the test cannot assert a
   *  statement the migration does not contain. */
  function backfillSql(): string {
    const file = path.join(
      process.cwd(),
      'prisma/migrations/20260818110000_work_item_repository_set/migration.sql',
    );
    const sql = readFileSync(file, 'utf8');
    const match = sql.match(/UPDATE "work_item"[\s\S]*?;/);
    if (!match) throw new Error('the repository-set migration no longer contains its backfill');
    return match[0];
  }

  it('turns every pre-existing pin into a one-element set and leaves null pins empty', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');

    const pinnedCore = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Pinned core', assigneeId: null },
      fx.ctx,
    );
    const pinnedAi = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Pinned ai', assigneeId: null },
      fx.ctx,
    );
    const unpinned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unpinned', assigneeId: null },
      fx.ctx,
    );
    const rolePinned = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Role only', assigneeId: null },
      fx.ctx,
    );

    // Put the rows back into the PRE-migration shape: a scalar pin, an empty set.
    // (`targetRepoRole` is what a plan records before its repositories exist.)
    await adminDb.workItem.update({
      where: { id: pinnedCore.id },
      data: { targetRepo: 'motir-core', targetRepos: [] },
    });
    await adminDb.workItem.update({
      where: { id: pinnedAi.id },
      data: { targetRepo: 'motir-ai', targetRepos: [] },
    });
    await adminDb.workItem.update({
      where: { id: unpinned.id },
      data: { targetRepo: null, targetRepos: [] },
    });
    await adminDb.workItem.update({
      where: { id: rolePinned.id },
      // ⚠️ `targetRepoRole` retired by MOTIR-3040 (§A3) — this fixture row is now
      // simply the UNPINNED shape, which is what the backfill assertion reads.
      data: { targetRepo: null, targetRepos: [] },
    });

    await adminDb.$executeRawUnsafe(backfillSql());

    expect(await row(pinnedCore.id)).toMatchObject({
      targetRepo: 'motir-core',
      targetRepos: ['motir-core'],
    });
    expect(await row(pinnedAi.id)).toMatchObject({
      targetRepo: 'motir-ai',
      targetRepos: ['motir-ai'],
    });
    expect(await row(unpinned.id)).toMatchObject({ targetRepo: null, targetRepos: [] });
    // The role column is NOT widened and NOT backfilled (ADR §1.3) — and it is
    // now RETIRED outright (MOTIR-3040, §A3), so what this row asserts is the
    // half that survives: a row with no NAME pin keeps its empty set, and the
    // MOTIR-2725 backfill never invented one for it.
    expect(await row(rolePinned.id)).toMatchObject({
      targetRepo: null,
      targetRepos: [],
    });
  });

  it('is IDEMPOTENT — re-running it over already-backfilled rows changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Already migrated',
        assigneeId: null,
        targetRepos: ['motir-core'],
      },
      fx.ctx,
    );
    await adminDb.$executeRawUnsafe(backfillSql());
    expect(await row(item.id)).toMatchObject({
      targetRepo: 'motir-core',
      targetRepos: ['motir-core'],
    });
  });
});

describe("DISPATCH is unchanged for every row shape the migration leaves — ADR §2's boundary", () => {
  it('resolves the same repository for pinned, role-pinned and unpinned rows', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai', 'trunk');

    const pinnedItem = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Pinned',
        assigneeId: null,
        targetRepos: ['motir-ai', 'motir-core'],
      },
      fx.ctx,
    );
    const unpinnedItem = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unpinned', assigneeId: null },
      fx.ctx,
    );
    // An N-repo card routes to its PRIMARY, with that repository's own mirrored
    // default branch — never a hard-coded 'main'.
    const pinnedRow = await row(pinnedItem.id);
    expect(await resolveItemDispatchRepo(pinnedRow.targetRepo, fx.projectId, fx.ctx)).toEqual({
      name: 'motir-ai',
      cloneUrl: 'https://github.com/moooon/motir-ai.git',
      defaultBranch: 'trunk',
    });

    // A role-pinned, name-unpinned card is still "Motir does not know" against a
    // two-repository domain — the set changed nothing about the refusal to guess.
    const unpinnedRow = await row(unpinnedItem.id);
    expect(await resolveItemDispatchRepo(unpinnedRow.targetRepo, fx.projectId, fx.ctx)).toBeNull();
  });
});
