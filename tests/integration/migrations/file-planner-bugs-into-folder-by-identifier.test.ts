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

// MOTIR-5919 — the RE-RUN of the planner-bug folder migration, keyed by the
// project's IDENTIFIER. `20260919210100_file_planner_bugs_into_folder` scoped
// every statement on `p."name" = 'motir'`; the deployed meta project is named
// `Motir`, so it wrote nothing in production (read by MOTIR-5829). Its own test
// seeded `name: 'motir'` — the literal the SQL expected, not the value the
// tenant held — which is why this file seeds the DEPLOYED shape instead: a
// project named `Motir`, a `Planning bugs` folder that ALREADY exists under
// `Bugs` and already holds records moved there by hand, and a home story with
// what was left under it.

function readMigration(dir: string): string {
  return readFileSync(join(process.cwd(), 'prisma/migrations', dir, 'migration.sql'), 'utf8');
}

const APPLIED_SQL = readMigration('20260919210100_file_planner_bugs_into_folder');
const MIGRATION_SQL = readMigration('20260921190000_file_planner_bugs_into_folder_by_identifier');

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function run(sql: string): Promise<void> {
  const statements = statementsOf(sql);
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

/** A tenant with ONE project. `meta` flips its organisation to the meta org;
 *  `name` / `identifier` default to the DEPLOYED meta project's. */
async function makeTenant(opts: { meta: boolean; name?: string; identifier?: string }) {
  const n = seq++;
  const owner = await usersService.createUser({
    email: `pbfi-owner-${n}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `ws-${n}`,
    ownerUserId: owner.id,
  });
  if (opts.meta) {
    await adminDb.$transaction((tx: Prisma.TransactionClient) =>
      organizationRepository.update(workspace.organizationId, { isMeta: true }, tx),
    );
  }
  const project = await projectsService.createProject({
    name: opts.name ?? 'Motir',
    identifier: opts.identifier ?? 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  return { ctx, projectId: project.id, workspaceId: workspace.id };
}

type Tenant = Awaited<ReturnType<typeof makeTenant>>;

function creator(t: Tenant) {
  return (data: Record<string, unknown>) =>
    workItemsService.createWorkItem({ projectId: t.projectId, ...data } as never, t.ctx);
}

/** The deployed `Planning bugs` folder: already under `Bugs`, already holding a
 *  hand-moved record and a subfolder with another — none of which the
 *  migration may touch. */
async function makeExistingFolder(t: Tenant) {
  const bugs = await seededBugsFolderId(t.projectId);
  const folder = await adminDb.folder.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      parentFolderId: bugs,
      name: 'Planning bugs',
      position: 'a0',
      createdById: t.ctx.userId,
    },
  });
  const sub = await adminDb.folder.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      parentFolderId: folder.id,
      name: 'Fixed planning bugs 2026-09-19',
      position: 'a0',
      createdById: t.ctx.userId,
    },
  });
  const create = creator(t);
  const filed = await create({ kind: 'bug', title: 'hand-moved open bug', folderId: folder.id });
  const fixed = await create({ kind: 'bug', title: 'hand-moved fixed bug', folderId: sub.id });
  await adminDb.workItem.update({ where: { id: fixed.id }, data: { status: 'done' } });
  return { bugs, folderId: folder.id, subId: sub.id, filedIds: [filed.id, fixed.id] };
}

/** The deployed home story: what was LEFT under it after the hand move —
 *  four `done` subtasks and one `cancelled` bug. */
async function makeHome(t: Tenant) {
  const create = creator(t);
  const story = await create({ kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE });
  const childIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const sub = await create({
      kind: 'subtask',
      title: `leftover subtask ${i}`,
      parentId: story.id,
    });
    await adminDb.workItem.update({ where: { id: sub.id }, data: { status: 'done' } });
    childIds.push(sub.id);
  }
  const bug = await create({ kind: 'bug', title: 'leftover bug', parentId: story.id });
  await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'cancelled' } });
  childIds.push(bug.id);
  await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });
  return { storyId: story.id, childIds };
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

async function snapshot(t: Tenant, ids: string[]) {
  return {
    folders: await adminDb.folder.findMany({
      where: { projectId: t.projectId },
      orderBy: { id: 'asc' },
    }),
    project: await project(t),
    items: await adminDb.workItem.findMany({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
    }),
  };
}

describe('the REPRODUCTION — the applied migration on the deployed shape', () => {
  it('writes NOTHING when the meta project is named `Motir`: no pointer, the children stay, the story is not archived', async () => {
    const t = await makeTenant({ meta: true });
    await makeExistingFolder(t);
    const home = await makeHome(t);

    await run(APPLIED_SQL);

    expect((await project(t)).plannerBugDestinationFolderId).toBeNull();
    expect(await adminDb.workItem.count({ where: { parentId: home.storyId } })).toBe(5);
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.storyId } });
    expect(story.archivedAt).toBeNull();
  });
});

describe('on the deployed meta tenant', () => {
  it('ADOPTS the existing folder, points at it, moves the leftovers in beside the hand-moved records, and archives the story', async () => {
    const t = await makeTenant({ meta: true });
    const existing = await makeExistingFolder(t);
    const home = await makeHome(t);
    const foldersBefore = await adminDb.folder.count({ where: { projectId: t.projectId } });
    const filedBefore = await adminDb.workItem.findMany({
      where: { id: { in: existing.filedIds } },
      orderBy: { id: 'asc' },
    });

    await run(MIGRATION_SQL);

    const p = await project(t);
    expect(p.plannerBugDestinationFolderId).toBe(existing.folderId);
    expect(p.bugDestinationFolderId).toBe(existing.bugs); // untouched
    expect(await adminDb.folder.count({ where: { projectId: t.projectId } })).toBe(foldersBefore);

    const children = await adminDb.workItem.findMany({ where: { id: { in: home.childIds } } });
    expect(children).toHaveLength(5);
    for (const c of children) {
      expect(c.folderId).toBe(existing.folderId);
      expect(c.parentId).toBeNull();
    }
    expect(await adminDb.workItem.count({ where: { parentId: home.storyId } })).toBe(0);

    // The records already in the folder, and in its subfolder, are not touched.
    expect(
      await adminDb.workItem.findMany({
        where: { id: { in: existing.filedIds } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(filedBefore);

    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: home.storyId } });
    expect(story.archivedAt).not.toBeNull();
    expect(story.status).toBe('done'); // ARCHIVED, its status never written
  });

  it('writes NO status — the leftovers arrive `done` ×4 and `cancelled` ×1, as they left', async () => {
    const t = await makeTenant({ meta: true });
    await makeExistingFolder(t);
    const home = await makeHome(t);
    expect(await histogram(home.childIds)).toEqual({ done: 4, cancelled: 1 });

    await run(MIGRATION_SQL);

    expect(await histogram(home.childIds)).toEqual({ done: 4, cancelled: 1 });
  });

  it('is idempotent — a second run changes nothing', async () => {
    const t = await makeTenant({ meta: true });
    const existing = await makeExistingFolder(t);
    const home = await makeHome(t);
    const ids = [home.storyId, ...home.childIds, ...existing.filedIds];
    await run(MIGRATION_SQL);
    const first = await snapshot(t, ids);

    await run(MIGRATION_SQL);

    expect(await snapshot(t, ids)).toEqual(first);
  });

  it('keys on the IDENTIFIER, not the name — a renamed project is still found', async () => {
    const t = await makeTenant({ meta: true, name: 'Motir (renamed)' });
    const existing = await makeExistingFolder(t);
    const home = await makeHome(t);

    await run(MIGRATION_SQL);

    expect((await project(t)).plannerBugDestinationFolderId).toBe(existing.folderId);
    expect(await adminDb.workItem.count({ where: { parentId: home.storyId } })).toBe(0);
  });

  it('is a no-op where the APPLIED migration already did the work — a database whose project was named `motir`', async () => {
    const t = await makeTenant({ meta: true, name: 'motir' });
    const home = await makeHome(t);
    await run(APPLIED_SQL);
    const ids = [home.storyId, ...home.childIds];
    const after = await snapshot(t, ids);
    expect(after.project.plannerBugDestinationFolderId).not.toBeNull();

    await run(MIGRATION_SQL);

    expect(await snapshot(t, ids)).toEqual(after);
  });
});

describe('everywhere else it is a no-op', () => {
  it('never touches a CUSTOMER project, even one carrying the identifier `MOTIR` and a story titled like the home', async () => {
    const t = await makeTenant({ meta: false });
    const existing = await makeExistingFolder(t);
    const home = await makeHome(t);
    const ids = [home.storyId, ...home.childIds, ...existing.filedIds];
    const before = await snapshot(t, ids);

    await run(MIGRATION_SQL);

    expect(await snapshot(t, ids)).toEqual(before);
  });

  it('never touches another meta project — one named `motir` with a different identifier', async () => {
    const t = await makeTenant({ meta: true, name: 'motir', identifier: 'MTR' });
    const home = await makeHome(t);
    const ids = [home.storyId, ...home.childIds];
    const before = await snapshot(t, ids);

    await run(MIGRATION_SQL);

    expect(await snapshot(t, ids)).toEqual(before);
  });
});

describe('the SQL and the TypeScript agree', () => {
  const sql = statementsOf(MIGRATION_SQL).join('\n');

  it('matches the story by exactly PLANNER_BUG_HOME_STORY_TITLE', () => {
    const literals = sql.match(/"title" = '([^']+)'/g);
    expect(literals).not.toBeNull();
    expect(new Set(literals)).toEqual(new Set([`"title" = '${PLANNER_BUG_HOME_STORY_TITLE}'`]));
  });

  it('scopes every statement by the project IDENTIFIER and never by its name', () => {
    expect(sql).not.toMatch(/p\."name"/);
    expect(sql.match(/p\."identifier" = 'MOTIR'/g)).toHaveLength(4);
  });
});
