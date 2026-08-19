import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { resolveItemDispatchRepo } from '@/lib/workItems/dispatchRepo';
import { ContainerRepoSetNotWritableError } from '@/lib/workItems/errors';
import { presentMcpWorkItem } from '@/lib/mcp/payloads/workItems';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// A CONTAINER's repository set is the UNION of its leaves' (Story MOTIR-2732 ·
// MOTIR-2978, ADR `docs/decisions/work-item-repository-set.md` "Amendment
// 2026-08-18" §A6), over real Postgres.
//
// The capability MOTIR-2725 built — a completion gate that holds a parent open
// until every repository has merged — had nothing to hold a parent ON, because
// every writer derived a card's set from that card's OWN pin. This file asserts
// the derivation that finally feeds it, and the four things only a real tree and
// a real transaction can answer:
//
//   1. The UNION reads back through every surface, in the PROJECT's order.
//   2. Every write that can MOVE the union recomputes it — a set change, a
//      re-parent, an archive, an unarchive, a delete — through a three-level tree.
//   3. Two children updated CONCURRENTLY both survive (§A6's row lock).
//   4. A direct write to a container is REFUSED, not silently erased.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

let nextPosition = 0;

/** One row in the project's repository set, realized against a connected repo.
 *  `position` is monotonic so the SET ORDER is the order rows were added — which
 *  is the order §A6 makes the union render in. */
async function addRepoRow(fx: WorkItemFixture, name: string): Promise<string> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const gh = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'other',
      name,
      seedSource: 'blank',
      state: 'connected',
      position: `a${(nextPosition++).toString(36).padStart(4, '0')}`,
      githubRepoId: gh.id,
    },
  });
  return row.id;
}

/** An item's stored references, in set order, as repository NAMES. */
async function repoNames(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRepo.findMany({
    where: { workItemId },
    orderBy: { position: 'asc' },
    include: { projectRepo: true },
  });
  return rows.map((r) => r.projectRepo.name);
}

/** epic → story → two subtasks, each subtask in its own repository. */
async function threeLevelTree(fx: WorkItemFixture, core: string, ai: string) {
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Epic', assigneeId: null },
    fx.ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Story', assigneeId: null, parentId: epic.id },
    fx.ctx,
  );
  const a = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      title: 'Ships in core',
      assigneeId: null,
      parentId: story.id,
      targetRepositories: [core],
    },
    fx.ctx,
  );
  const b = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      title: 'Ships in ai',
      assigneeId: null,
      parentId: story.id,
      targetRepositories: [ai],
    },
    fx.ctx,
  );
  return { epic, story, a, b };
}

describe('the UNION', () => {
  it('rolls a two-repository story up through THREE levels, in the project’s order', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { epic, story, a, b } = await threeLevelTree(fx, core, ai);

    // The leaves keep their OWN, authored sets — one each.
    expect(await repoNames(a.id)).toEqual(['motir-core']);
    expect(await repoNames(b.id)).toEqual(['motir-ai']);
    // The container derives BOTH, and so does its container.
    expect(await repoNames(story.id)).toEqual(['motir-core', 'motir-ai']);
    expect(await repoNames(epic.id)).toEqual(['motir-core', 'motir-ai']);
  });

  it('orders by the PROJECT’s set order, not by which child appeared first', async () => {
    // §A6's clause, and the one that differs from this card's as-authored body.
    // The child that ships in the LATER project repository is created FIRST, so
    // first-appearance order would put them the other way round.
    const fx = await makeWorkItemFixture();
    const first = await addRepoRow(fx, 'aaa-first-in-project');
    const second = await addRepoRow(fx, 'zzz-second-in-project');

    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', assigneeId: null },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'created first, later repo',
        assigneeId: null,
        parentId: story.id,
        targetRepositories: [second],
      },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'created second, earlier repo',
        assigneeId: null,
        parentId: story.id,
        targetRepositories: [first],
      },
      fx.ctx,
    );

    expect(await repoNames(story.id)).toEqual(['aaa-first-in-project', 'zzz-second-in-project']);
  });

  it('DE-DUPLICATES — two subtasks in one repository make a one-element union', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', assigneeId: null },
      fx.ctx,
    );
    for (const title of ['one', 'two']) {
      await workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'subtask',
          title,
          assigneeId: null,
          parentId: story.id,
          targetRepositories: [core],
        },
        fx.ctx,
      );
    }
    expect(await repoNames(story.id)).toEqual(['motir-core']);
  });

  it('leaves a container with no pinned descendants EMPTY', async () => {
    const fx = await makeWorkItemFixture();
    await addRepoRow(fx, 'motir-core');
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', assigneeId: null },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'unpinned',
        assigneeId: null,
        parentId: story.id,
      },
      fx.ctx,
    );
    expect(await repoNames(story.id)).toEqual([]);
  });
});

describe('every write that can MOVE the union recomputes it', () => {
  it('a leaf’s repository CHANGING moves both ancestors', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const gateway = await addRepoRow(fx, 'motir-gateway');
    const { epic, story, a } = await threeLevelTree(fx, core, ai);

    await workItemsService.updateWorkItem(a.id, { targetRepositories: [gateway] }, fx.ctx);

    expect(await repoNames(story.id)).toEqual(['motir-ai', 'motir-gateway']);
    expect(await repoNames(epic.id)).toEqual(['motir-ai', 'motir-gateway']);
  });

  it('a RE-PARENT moves BOTH chains — the one left and the one joined', async () => {
    // The half a walk-up-from-the-item cannot reach: once the row has moved, the
    // old parent is no longer an ancestor of anything the caller holds.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { story, b } = await threeLevelTree(fx, core, ai);
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Other story', assigneeId: null },
      fx.ctx,
    );

    await workItemsService.updateWorkItem(b.id, { parentId: other.id }, fx.ctx);

    // LEFT: the ai repository goes with the child.
    expect(await repoNames(story.id)).toEqual(['motir-core']);
    // JOINED: and arrives here.
    expect(await repoNames(other.id)).toEqual(['motir-ai']);
  });

  it('ARCHIVING a leaf removes its repository; UNARCHIVING puts it back', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { epic, story, b } = await threeLevelTree(fx, core, ai);

    await workItemsService.archiveWorkItem(b.id, fx.ctx);
    // A parent is not waiting on work archived out of it (§A6).
    expect(await repoNames(story.id)).toEqual(['motir-core']);
    expect(await repoNames(epic.id)).toEqual(['motir-core']);

    await workItemsService.unarchiveWorkItem(b.id, fx.ctx);
    expect(await repoNames(story.id)).toEqual(['motir-core', 'motir-ai']);
    expect(await repoNames(epic.id)).toEqual(['motir-core', 'motir-ai']);
  });

  it('DELETING a leaf removes its repository from the surviving ancestors', async () => {
    // The deleted row's references cascade away with it — but a STORED derived
    // set does not update itself, which is the whole reason this is a trigger.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { epic, story, b } = await threeLevelTree(fx, core, ai);

    await workItemsService.deleteWorkItem(b.id, fx.ctx);

    expect(await repoNames(story.id)).toEqual(['motir-core']);
    expect(await repoNames(epic.id)).toEqual(['motir-core']);
  });
});

describe('concurrency — §A6’s row lock', () => {
  it('two children updated CONCURRENTLY both survive in the parent’s set', async () => {
    // The lost update this exists to prevent: each update derives the parent, and
    // without the lock the later write can be derived from a snapshot taken
    // before the earlier one landed — dropping a repository silently.
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const gateway = await addRepoRow(fx, 'motir-gateway');
    const meta = await addRepoRow(fx, 'motir-meta');
    const { story, a, b } = await threeLevelTree(fx, core, ai);

    await Promise.all([
      workItemsService.updateWorkItem(a.id, { targetRepositories: [gateway] }, fx.ctx),
      workItemsService.updateWorkItem(b.id, { targetRepositories: [meta] }, fx.ctx),
    ]);

    // BOTH, in project order — neither recompute may erase the other's child.
    expect(await repoNames(story.id)).toEqual(['motir-gateway', 'motir-meta']);
  });
});

describe('a container’s set is DERIVED, so a direct write is REFUSED', () => {
  it('rejects it at the service, with the typed error', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { story } = await threeLevelTree(fx, core, ai);

    await expect(
      workItemsService.updateWorkItem(story.id, { targetRepositories: [core] }, fx.ctx),
    ).rejects.toBeInstanceOf(ContainerRepoSetNotWritableError);

    // And it wrote NOTHING — the derived set is untouched, not half-replaced.
    expect(await repoNames(story.id)).toEqual(['motir-core', 'motir-ai']);
  });

  it('rejects the NAME forms too — the refusal is about the item, not the field', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { story } = await threeLevelTree(fx, core, ai);

    for (const patch of [{ targetRepo: 'motir-core' }, { targetRepos: ['motir-core'] }]) {
      await expect(workItemsService.updateWorkItem(story.id, patch, fx.ctx)).rejects.toBeInstanceOf(
        ContainerRepoSetNotWritableError,
      );
    }
  });

  it('still allows a LEAF to be written — the refusal is not a blanket read-only', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { a } = await threeLevelTree(fx, core, ai);

    await workItemsService.updateWorkItem(a.id, { targetRepositories: [ai] }, fx.ctx);
    expect(await repoNames(a.id)).toEqual(['motir-ai']);
  });
});

describe('the boundary this card must not cross', () => {
  it('DISPATCH is unchanged — a leaf still resolves its own repository', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    await threeLevelTree(fx, core, ai);

    expect((await resolveItemDispatchRepo('motir-core', fx.projectId, fx.ctx))?.name).toBe(
      'motir-core',
    );
    // Two established repositories and no pin still refuses to guess.
    expect(await resolveItemDispatchRepo(null, fx.projectId, fx.ctx)).toBeNull();
  });

  it('the MCP payload agrees with the stored set for the same container', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const { story } = await threeLevelTree(fx, core, ai);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    const payload = presentMcpWorkItem(toWorkItemDto(row)) as { targetRepos?: string[] };
    // The derived NAMES are what every surface publishes (§A4), so the payload
    // and the join table can never describe different repositories.
    expect(await repoNames(story.id)).toEqual(['motir-core', 'motir-ai']);
    expect(payload.targetRepos ?? []).toEqual(row.targetRepos);
  });
});

describe('tenancy', () => {
  it('the rollup never reaches outside its workspace', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A' });
    const b = await makeWorkItemFixture({ name: 'Tenant B' });
    const aRepo = await addRepoRow(a, 'a-web');
    const bRepo = await addRepoRow(b, 'b-web');

    const aStory = await workItemsService.createWorkItem(
      { projectId: a.projectId, kind: 'story', title: "A's story", assigneeId: null },
      a.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: a.projectId,
        kind: 'subtask',
        title: "A's leaf",
        assigneeId: null,
        parentId: aStory.id,
        targetRepositories: [aRepo],
      },
      a.ctx,
    );
    const bStory = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: "B's story", assigneeId: null },
      b.ctx,
    );
    await workItemsService.createWorkItem(
      {
        projectId: b.projectId,
        kind: 'subtask',
        title: "B's leaf",
        assigneeId: null,
        parentId: bStory.id,
        targetRepositories: [bRepo],
      },
      b.ctx,
    );

    expect(await repoNames(aStory.id)).toEqual(['a-web']);
    expect(await repoNames(bStory.id)).toEqual(['b-web']);
  });
});
