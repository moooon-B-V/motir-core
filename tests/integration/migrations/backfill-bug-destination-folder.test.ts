import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { db } from '@/lib/db';
import { DEFAULT_BUG_FOLDER_NAME } from '@/lib/projects/bugDestination';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject, seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The BACKFILL data migration — Story MOTIR-4927 · Subtask MOTIR-4936. Every
// project that existed before projects were born with a Bugs folder gets one:
// ADOPT a root folder already named bugs (any case), CREATE one otherwise, and
// point the destination at it. Only NULL pointers are touched, archived projects
// included. Run against real Postgres with both populations in ONE database.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260914200100_backfill_project_bug_destination_folder/migration.sql',
  ),
  'utf8',
);

/** Execute the migration's statements the way `migrate deploy` would, one at a time. */
async function runMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(statements).toHaveLength(2);
  for (const stmt of statements) {
    await adminDb.$executeRawUnsafe(stmt);
  }
}

/**
 * Put a project back in its PRE-SEED state — no destination and no Bugs folder —
 * which is what every project that existed before MOTIR-4935 looks like.
 */
async function asBeforeTheSeed(projectId: string): Promise<void> {
  const seeded = await seededBugsFolderId(projectId);
  await adminDb.project.update({
    where: { id: projectId },
    data: { bugDestinationFolderId: null },
  });
  await adminDb.folder.delete({ where: { id: seeded } });
}

async function destinationOf(projectId: string) {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return project.bugDestinationFolderId;
}

async function rootFolderNames(projectId: string) {
  const rows = await adminDb.folder.findMany({
    where: { projectId, parentFolderId: null },
    orderBy: { position: 'asc' },
  });
  return rows.map((f) => f.name);
}

async function secondProject(fx: WorkItemFixture, identifier: string) {
  return createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: `Project ${identifier}`,
    identifier,
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the backfill, over both populations in one database', () => {
  it('CREATES a Bugs folder after the existing root folders where there is none, and ADOPTS one already named bugs', async () => {
    const fx = await makeWorkItemFixture();
    // Population 2: no root folder named bugs, but other root folders already.
    await asBeforeTheSeed(fx.projectId);
    await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Later' },
      fx.ctx,
    );
    // Population 1: a root folder named bugs in another case, and no pointer.
    const adopter = await secondProject(fx, 'ADOPT');
    const existing = await seededBugsFolderId(adopter.id);
    await adminDb.project.update({
      where: { id: adopter.id },
      data: { bugDestinationFolderId: null },
    });
    await adminDb.folder.update({ where: { id: existing }, data: { name: 'BUGS' } });
    const before = await adminDb.folder.findUniqueOrThrow({ where: { id: existing } });

    await runMigration();

    // Created: named from the label, a ROOT folder, sorted AFTER "Later", pointed at.
    expect(await rootFolderNames(fx.projectId)).toEqual(['Later', DEFAULT_BUG_FOLDER_NAME]);
    const created = await adminDb.folder.findFirstOrThrow({
      where: { projectId: fx.projectId, name: DEFAULT_BUG_FOLDER_NAME },
    });
    expect(created).toMatchObject({ parentFolderId: null, createdById: fx.ownerId });
    expect(await destinationOf(fx.projectId)).toBe(created.id);

    // Adopted: pointed at the folder it already had, which is byte-identical,
    // and no second folder was made.
    expect(await destinationOf(adopter.id)).toBe(existing);
    expect(await adminDb.folder.findUniqueOrThrow({ where: { id: existing } })).toEqual(before);
    expect(await adminDb.folder.count({ where: { projectId: adopter.id } })).toBe(1);
  });

  it('leaves NO project without a destination, ARCHIVED projects included', async () => {
    const fx = await makeWorkItemFixture();
    const archived = await secondProject(fx, 'ARCHV');
    await asBeforeTheSeed(fx.projectId);
    await asBeforeTheSeed(archived.id);
    await adminDb.project.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    await runMigration();

    expect(await adminDb.project.count({ where: { bugDestinationFolderId: null } })).toBe(0);
    expect(await destinationOf(archived.id)).not.toBeNull();
  });

  it('is a NO-OP the second time — pointers and folders are exactly as the first run left them', async () => {
    const fx = await makeWorkItemFixture();
    await asBeforeTheSeed(fx.projectId);

    await runMigration();
    const pointer = await destinationOf(fx.projectId);
    const folders = await adminDb.folder.findMany({ orderBy: { id: 'asc' } });

    await runMigration();

    expect(await destinationOf(fx.projectId)).toBe(pointer);
    expect(await adminDb.folder.findMany({ orderBy: { id: 'asc' } })).toEqual(folders);
  });

  it('does not touch a project that already has a destination', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await seededBugsFolderId(fx.projectId);
    const triage = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Triage' },
      fx.ctx,
    );
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { bugDestinationFolderId: triage.id },
    });

    await runMigration();

    expect(await destinationOf(fx.projectId)).toBe(triage.id);
    expect(await adminDb.folder.findUnique({ where: { id: seeded } })).not.toBeNull();
    expect(await adminDb.folder.count({ where: { projectId: fx.projectId } })).toBe(2);
  });

  it('leaves the planner-bug home story byte-identical — it is not a destination', async () => {
    const fx = await makeWorkItemFixture();
    await asBeforeTheSeed(fx.projectId);
    const home = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      fx.ctx,
    );
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.id } });

    await runMigration();

    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: home.id } })).toEqual(before);
    expect(await destinationOf(fx.projectId)).not.toBe(home.id);
  });
});

describe('the SQL and the TypeScript agree', () => {
  it('writes the same folder name as DEFAULT_BUG_FOLDER_NAME', () => {
    expect(MIGRATION_SQL).toContain(`NULL, '${DEFAULT_BUG_FOLDER_NAME}',`);
  });
});
