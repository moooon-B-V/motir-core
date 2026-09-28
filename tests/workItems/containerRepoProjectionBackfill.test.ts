import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// Bug MOTIR-6751 — the BACKFILL that re-syncs a container's stored repository
// NAMES (`targetRepos` / `targetRepo`) with the REFERENCES it holds, for the rows
// the approve path's re-derivation left stale before the code fix.
//
// ⚠️ THIS FILE EXECUTES THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION — the
// precedent is `project-pr-merge-mode-backfill.test.ts`. A retyped UPDATE would
// stay green while the shipped statement drifted.
//
// The trees are built through the real service path (which writes both halves),
// then the names are made stale by hand — the state an approve left behind.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260928110000_container_repo_projection_backfill/migration.sql',
);

/** The migration's one statement, comments stripped — extracted, never retyped. */
function backfillStatement(): string {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements, 'the migration must carry exactly ONE statement').toHaveLength(1);
  return statements[0]!;
}

async function runBackfill(): Promise<void> {
  await adminDb.$executeRawUnsafe(backfillStatement());
}

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

let nextPosition = 0;

/** One row in the project's repository set, realized against a connected repo. */
async function addRepoRow(fx: WorkItemFixture, name: string) {
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
      organizationId: fx.workspace.organizationId,
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
  return { rowId: row.id, githubRepoId: gh.id };
}

async function create(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'subtask',
  title: string,
  parentId?: string,
  targetRepositories?: string[],
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title,
      assigneeId: null,
      ...(parentId ? { parentId } : {}),
      ...(targetRepositories ? { targetRepositories } : {}),
    },
    fx.ctx,
  );
}

async function setNames(workItemId: string, targetRepos: string[]): Promise<void> {
  await adminDb.workItem.update({
    where: { id: workItemId },
    data: { targetRepos, targetRepo: targetRepos[0] ?? null },
  });
}

async function names(workItemId: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return { targetRepos: row.targetRepos, targetRepo: row.targetRepo };
}

describe('the MOTIR-6751 backfill', () => {
  it('re-syncs every stale container in a tree to its references, in set order', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const ai = await addRepoRow(fx, 'motir-ai');
    const epic = await create(fx, 'epic', 'Epic');
    const story = await create(fx, 'story', 'Story', epic.id);
    await create(fx, 'subtask', 'In ai', story.id, [ai.rowId]);
    await create(fx, 'subtask', 'In core', story.id, [core.rowId]);
    // What an approve left behind: the names a re-plan moved the work out of.
    await setNames(story.id, ['motir-marketing', 'motir-meta']);
    await setNames(epic.id, []);

    await runBackfill();

    // The PROJECT's set order, not child order — the rollup's own ordering.
    const expected = { targetRepos: ['motir-core', 'motir-ai'], targetRepo: 'motir-core' };
    expect(await names(story.id)).toEqual(expected);
    expect(await names(epic.id)).toEqual(expected);
  });

  it('resolves a name through the realized repository, as every reader does', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const story = await create(fx, 'story', 'Story');
    await create(fx, 'subtask', 'In core', story.id, [core.rowId]);
    // Renamed on the host: the realized repository's name wins over the row's.
    await adminDb.githubRepo.update({
      where: { id: core.githubRepoId },
      data: { name: 'motir-core-renamed' },
    });

    await runBackfill();

    expect(await names(story.id)).toEqual({
      targetRepos: ['motir-core-renamed'],
      targetRepo: 'motir-core-renamed',
    });
  });

  it('repairs a `targetRepo` that disagrees with an otherwise-correct set', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const story = await create(fx, 'story', 'Story');
    await create(fx, 'subtask', 'In core', story.id, [core.rowId]);
    await adminDb.workItem.update({ where: { id: story.id }, data: { targetRepo: 'elsewhere' } });

    await runBackfill();

    expect(await names(story.id)).toEqual({
      targetRepos: ['motir-core'],
      targetRepo: 'motir-core',
    });
  });

  it('clears the names of a container whose live children carry no references', async () => {
    const fx = await makeWorkItemFixture();
    await addRepoRow(fx, 'motir-core');
    const story = await create(fx, 'story', 'Story');
    await create(fx, 'subtask', 'Unpinned', story.id);
    await setNames(story.id, ['motir-marketing']);

    await runBackfill();

    expect(await names(story.id)).toEqual({ targetRepos: [], targetRepo: null });
  });

  it('leaves a LEAF alone — its names are authored with its references, not derived', async () => {
    const fx = await makeWorkItemFixture();
    const core = await addRepoRow(fx, 'motir-core');
    const story = await create(fx, 'story', 'Story');
    const leaf = await create(fx, 'subtask', 'In core', story.id, [core.rowId]);
    await setNames(leaf.id, ['something-else']);

    await runBackfill();

    expect(await names(leaf.id)).toEqual({
      targetRepos: ['something-else'],
      targetRepo: 'something-else',
    });
  });

  it('leaves a container in a project with NO repository set alone — its names are the only record', async () => {
    const fx = await makeWorkItemFixture();
    const story = await create(fx, 'story', 'Story');
    await create(fx, 'subtask', 'Child', story.id);
    await setNames(story.id, ['legacy-repo']);

    await runBackfill();

    expect(await names(story.id)).toEqual({
      targetRepos: ['legacy-repo'],
      targetRepo: 'legacy-repo',
    });
  });
});
