import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import { PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { db } from '@/lib/db';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The FILE-THE-PLANNER-BUGS data migration — Story MOTIR-5818 · Subtask
// MOTIR-5824. In the meta tenant's `motir` project it ADOPTS or CREATES a
// `Planning bugs` folder under the product bug destination, POINTS the
// planner-bug destination at it, MOVES every child of the old home story into
// it, and ARCHIVES the emptied story — without writing a single status. Run
// statement by statement against real Postgres, the way `migrate deploy` runs it.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260919210100_file_planner_bugs_into_folder/migration.sql',
  ),
  'utf8',
);

async function runMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(statements).toHaveLength(4);
  for (const stmt of statements) {
    await adminDb.$executeRawUnsafe(stmt);
  }
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A tenant with a `motir` project; `meta` flips its organisation to the meta
 *  org, which is the migration's scope key. */
async function makeTenant(meta: boolean) {
  const n = seq++;
  const owner = await usersService.createUser({
    email: `pbf-owner-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `ws-${n}`,
    ownerUserId: owner.id,
  });
  if (meta) {
    await adminDb.$transaction((tx: Prisma.TransactionClient) =>
      organizationRepository.update(workspace.organizationId, { isMeta: true }, tx),
    );
  }
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: `M${n}X`.replace(/[0-9]/g, 'Q'),
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  return { ctx, projectId: project.id, workspaceId: workspace.id };
}

type Tenant = Awaited<ReturnType<typeof makeTenant>>;

/** The old home, with the children it really holds: bugs in several statuses
 *  (`done` and `blocked` among them), an ARCHIVED bug, a subtask, and a task
 *  carrying a subtask of its own (a grandchild, which must stay with its task). */
async function makeHome(t: Tenant) {
  const create = (data: Record<string, unknown>) =>
    workItemsService.createWorkItem({ projectId: t.projectId, ...data } as never, t.ctx);
  const story = await create({ kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE });
  const open = await create({ kind: 'bug', title: 'open planning bug', parentId: story.id });
  const done = await create({ kind: 'bug', title: 'done planning bug', parentId: story.id });
  const blocked = await create({ kind: 'bug', title: 'blocked planning bug', parentId: story.id });
  const archived = await create({
    kind: 'bug',
    title: 'archived planning bug',
    parentId: story.id,
  });
  const sub = await create({ kind: 'subtask', title: 'a subtask', parentId: story.id });
  const task = await create({ kind: 'task', title: 'a task', parentId: story.id });
  const grandchild = await create({ kind: 'subtask', title: 'grandchild', parentId: task.id });
  await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'done' } });
  await adminDb.workItem.update({ where: { id: blocked.id }, data: { status: 'blocked' } });
  await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  return {
    storyId: story.id,
    childIds: [open.id, done.id, blocked.id, archived.id, sub.id, task.id],
    grandchildId: grandchild.id,
    taskId: task.id,
  };
}

async function histogram(ids: string[]) {
  const rows = await adminDb.workItem.findMany({
    where: { id: { in: ids } },
    select: { status: true },
  });
  const h: Record<string, number> = {};
  for (const r of rows) h[r.status] = (h[r.status] ?? 0) + 1;
  return h;
}

async function project(t: Tenant) {
  return adminDb.project.findUniqueOrThrow({ where: { id: t.projectId } });
}

describe('on the meta tenant holding the home story', () => {
  it('creates `Planning bugs` under the bug destination, points at it, moves EVERY child in, and archives the story', async () => {
    const t = await makeTenant(true);
    const bugs = await seededBugsFolderId(t.projectId);
    const home = await makeHome(t);
    const storyBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.storyId } });

    await runMigration();

    const folder = await adminDb.folder.findFirstOrThrow({
      where: { projectId: t.projectId, name: 'Planning bugs' },
    });
    expect(folder.parentFolderId).toBe(bugs);
    expect((await project(t)).plannerBugDestinationFolderId).toBe(folder.id);
    expect((await project(t)).bugDestinationFolderId).toBe(bugs); // untouched

    const children = await adminDb.workItem.findMany({ where: { id: { in: home.childIds } } });
    expect(children).toHaveLength(home.childIds.length);
    for (const c of children) {
      expect(c.folderId).toBe(folder.id);
      expect(c.parentId).toBeNull();
    }
    expect(await adminDb.workItem.count({ where: { parentId: home.storyId } })).toBe(0);

    // The grandchild stays with its task, which is what moved.
    const grandchild = await adminDb.workItem.findUniqueOrThrow({
      where: { id: home.grandchildId },
    });
    expect(grandchild.parentId).toBe(home.taskId);

    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.storyId } });
    expect(story.archivedAt).not.toBeNull();
    expect(story.status).toBe(storyBefore.status); // ARCHIVED, never closed
  });

  it('writes NO status — the histogram is identical before and after, archived child included', async () => {
    const t = await makeTenant(true);
    const home = await makeHome(t);
    const ids = [...home.childIds, home.grandchildId];
    const before = await histogram(ids);
    const archivedBefore = await adminDb.workItem.count({
      where: { id: { in: ids }, archivedAt: { not: null } },
    });

    await runMigration();

    expect(await histogram(ids)).toEqual(before);
    expect(
      await adminDb.workItem.count({ where: { id: { in: ids }, archivedAt: { not: null } } }),
    ).toBe(archivedBefore);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const t = await makeTenant(true);
    const home = await makeHome(t);
    await runMigration();
    const snapshot = async () => ({
      folders: await adminDb.folder.findMany({
        where: { projectId: t.projectId },
        orderBy: { id: 'asc' },
      }),
      project: await project(t),
      items: await adminDb.workItem.findMany({
        where: { id: { in: [home.storyId, ...home.childIds] } },
        orderBy: { id: 'asc' },
      }),
    });
    const first = await snapshot();

    await runMigration();

    expect(await snapshot()).toEqual(first);
  });

  it('ADOPTS an existing `Planning bugs` folder under the destination, any case, instead of duplicating it', async () => {
    const t = await makeTenant(true);
    const bugs = await seededBugsFolderId(t.projectId);
    const existing = await adminDb.folder.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        parentFolderId: bugs,
        name: 'planning BUGS',
        position: 'a0',
        createdById: t.ctx.userId,
      },
    });
    await makeHome(t);

    await runMigration();

    expect((await project(t)).plannerBugDestinationFolderId).toBe(existing.id);
    expect(
      await adminDb.folder.count({ where: { projectId: t.projectId, parentFolderId: bugs } }),
    ).toBe(1);
  });

  it('creates the folder at the project ROOT when the bug destination is the root', async () => {
    const t = await makeTenant(true);
    await adminDb.project.update({
      where: { id: t.projectId },
      data: { bugDestinationFolderId: null },
    });
    const home = await makeHome(t);

    await runMigration();

    const pointer = (await project(t)).plannerBugDestinationFolderId;
    const folder = await adminDb.folder.findUniqueOrThrow({ where: { id: pointer! } });
    expect(folder.parentFolderId).toBeNull();
    expect(folder.name).toBe('Planning bugs');
    expect(await adminDb.workItem.count({ where: { parentId: home.storyId } })).toBe(0);
  });
});

describe('everywhere else it is a no-op', () => {
  it('changes nothing on a meta tenant with NO home story', async () => {
    const t = await makeTenant(true);
    const foldersBefore = await adminDb.folder.count({ where: { projectId: t.projectId } });

    await runMigration();

    expect((await project(t)).plannerBugDestinationFolderId).toBeNull();
    expect(await adminDb.folder.count({ where: { projectId: t.projectId } })).toBe(foldersBefore);
  });

  it('never touches a CUSTOMER project, even one with a story titled like the home', async () => {
    const t = await makeTenant(false);
    const home = await makeHome(t);
    const before = await adminDb.workItem.findMany({
      where: { id: { in: [home.storyId, ...home.childIds] } },
      orderBy: { id: 'asc' },
    });

    await runMigration();

    expect((await project(t)).plannerBugDestinationFolderId).toBeNull();
    expect(
      await adminDb.workItem.findMany({
        where: { id: { in: [home.storyId, ...home.childIds] } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
  });
});

describe('the SQL and the TypeScript agree', () => {
  it('matches the story by exactly PLANNER_BUG_HOME_STORY_TITLE', () => {
    const literals = MIGRATION_SQL.split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .match(/"title" = '([^']+)'/g);
    expect(literals).not.toBeNull();
    expect(new Set(literals)).toEqual(new Set([`"title" = '${PLANNER_BUG_HOME_STORY_TITLE}'`]));
  });
});
