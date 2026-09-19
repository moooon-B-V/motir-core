import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '@/app/api/internal/ai/work-items/route';
import { PLANNER_BUG_HOME_MARKER, PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The STORY GATE for "planning bugs are FILED into the Planning bugs folder" —
// Story MOTIR-5818 · Subtask MOTIR-5827. The ASSEMBLED seam, on a real Postgres:
// a pointer added by one card (MOTIR-5820), read by the resolver of another
// (MOTIR-5822), carried by a third's folder delete (MOTIR-5821) and written by a
// fourth's data migration (MOTIR-5824) — driven through the REAL filer
// (`POST /api/internal/ai/work-items` → `aiWorkItemsService.fileBug`). Each card's
// own tests prove its layer; this file proves the JOINS, and nothing is mocked.
//
// ⚠️ THREE SERVICES, ONE COLUMN, AND THE FAILURE MODE IS THAT EACH IS INDIVIDUALLY
// CORRECT. The resolver can read a pointer the delete would have moved; the
// migration can set a pointer the resolver reaches through a different rung. No
// unit sees either, because neither lives in one file.
//
// The four legs the card asks for:
//   1  the LADDER — unset ⇒ the product destination ⇒ the project root
//   2  SET ⇒ filed into that folder, with a null parent, as a ROOT
//   3  the destination folder DELETED ⇒ the pointer carries, and the next filing follows it
//   4  the MIGRATION's end state — empty, archived, and no status written
//
// There is no settings-write leg: the story ships no control, and the only writer
// of this pointer is the migration (the re-plan of 2026-09-19, MOTIR-5832).

const SECRET = 'planner-bug-destination-story-gate-secret';
const PASSWORD = 'planner-bug-gate-pass-123';

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260919210100_file_planner_bugs_into_folder/migration.sql',
  ),
  'utf8',
);

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  workspaceId: string;
}

/** A META workspace (the migration's scope key), its `motir` project made by the
 *  REAL `createProject`, and the system principal the filer acts as. */
async function makeTenant(tag: string, identifier: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: `planner-gate-${tag}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Planner gate ${tag}`,
    ownerUserId: owner.id,
  });
  await adminDb.$transaction((tx: Prisma.TransactionClient) =>
    organizationRepository.update(workspace.organizationId, { isMeta: true }, tx),
  );
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'motir',
    identifier,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
    workspaceId: workspace.id,
  };
}

/** File a PLANNING bug through the REAL internal filer, and read it back. */
async function filePlanningBug(projectKey: string, title: string) {
  const res = await POST(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        projectKey,
        kind: 'bug',
        title,
        parentKey: PLANNER_BUG_HOME_MARKER,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

function folder(t: Tenant, name: string, parentFolderId: string | null) {
  return foldersService.createFolder({ projectId: t.projectId, parentFolderId, name }, t.ctx);
}

async function pointers(projectId: string) {
  const p = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return { product: p.bugDestinationFolderId, planner: p.plannerBugDestinationFolderId };
}

async function pointPlannerAt(projectId: string, folderId: string | null) {
  await adminDb.project.update({
    where: { id: projectId },
    data: { plannerBugDestinationFolderId: folderId },
  });
}

/** Execute the migration's statements the way `migrate deploy` would. */
async function runMigration(): Promise<void> {
  const statements = MIGRATION_SQL.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await adminDb.$executeRawUnsafe(stmt);
  }
}

// ───────────────────────────────────────────────────────────────────────────

describe('seam 1 · the LADDER — every rung is a legal answer, and none of them 5xxs', () => {
  it('unset ⇒ the PRODUCT destination; that unset too ⇒ the project root', async () => {
    const t = await makeTenant('ladder', 'PGLAD');
    const bugs = await seededBugsFolderId(t.projectId);
    expect((await pointers(t.projectId)).planner).toBeNull(); // nothing seeds it

    const first = await filePlanningBug(t.projectKey, 'falls back to the product destination');
    expect(first.folderId).toBe(bugs);
    expect(first.parentId).toBeNull();

    await adminDb.project.update({
      where: { id: t.projectId },
      data: { bugDestinationFolderId: null },
    });
    const second = await filePlanningBug(t.projectKey, 'falls back to the root');
    expect(second.folderId).toBeNull();
    expect(second.parentId).toBeNull();
  });
});

describe('seam 2 · POINTED — the marker FILES, and the row is a ROOT', () => {
  it('lands in the planner-bug folder with a null parent, and the product destination is untouched', async () => {
    const t = await makeTenant('pointed', 'PGPTD');
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', bugs);
    await pointPlannerAt(t.projectId, planning.id);

    const filed = await filePlanningBug(t.projectKey, 'a captured planning mistake');

    expect(filed.folderId).toBe(planning.id);
    expect(filed.parentId).toBeNull();
    expect((await pointers(t.projectId)).product).toBe(bugs);

    // A ROOT for readiness and rollups: the real read finds it, and it is among the
    // project's PARENTLESS rows rather than any container's children.
    const read = await workItemsService.getWorkItemByIdentifier(
      t.projectId,
      filed.identifier,
      t.ctx,
    );
    expect(read.parentId).toBeNull();
    const roots = await adminDb.workItem.findMany({
      where: { projectId: t.projectId, parentId: null },
      select: { id: true },
    });
    expect(roots.map((r) => r.id)).toContain(filed.id);

    // And an ORDINARY bug — no marker — still goes to the product destination:
    // the two pointers are read by different calls and do not bleed.
    const ordinary = await POST(
      new Request('http://internal/api/internal/ai/work-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ projectKey: t.projectKey, kind: 'bug', title: 'a product bug' }),
      }),
    );
    expect(ordinary.status).toBe(201);
    const { id } = (await ordinary.json()) as { id: string };
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id } })).folderId).toBe(bugs);
  });
});

describe('seam 3 · the DELETE carries the pointer, and the next filing follows it', () => {
  it('a nested destination carries to its parent, in the same transaction the contents move in', async () => {
    const t = await makeTenant('carry', 'PGCAR');
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', bugs);
    await pointPlannerAt(t.projectId, planning.id);
    const before = await filePlanningBug(t.projectKey, 'filed before the delete');

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: planning.id }, t.ctx);

    expect((await pointers(t.projectId)).planner).toBe(bugs);
    // The record moved with the folder's other contents, not to nowhere.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: before.id } })).folderId).toBe(
      bugs,
    );

    const after = await filePlanningBug(t.projectKey, 'filed after the delete');
    expect(after.folderId).toBe(bugs);
    expect(after.parentId).toBeNull();
  });

  it('a ROOT destination carries to null, which is the fallback rung rather than breakage', async () => {
    const t = await makeTenant('carry-root', 'PGCRT');
    const bugs = await seededBugsFolderId(t.projectId);
    const planning = await folder(t, 'Planning bugs', null);
    await pointPlannerAt(t.projectId, planning.id);

    await foldersService.deleteFolder({ projectId: t.projectId, folderId: planning.id }, t.ctx);

    expect((await pointers(t.projectId)).planner).toBeNull();
    const after = await filePlanningBug(t.projectKey, 'filed after the root delete');
    expect(after.folderId).toBe(bugs); // rung 2 of the ladder, reached by a delete
  });
});

describe('seam 4 · the MIGRATION — the corpus moves, the story is archived, no status is written', () => {
  it('leaves the story empty and archived, the records in the folder, and the histogram identical', async () => {
    const t = await makeTenant('migration', 'PGMIG');
    const bugs = await seededBugsFolderId(t.projectId);

    const create = (data: Record<string, unknown>) =>
      workItemsService.createWorkItem({ projectId: t.projectId, ...data } as never, t.ctx);
    const story = await create({ kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE });
    const open = await create({ kind: 'bug', title: 'an open record', parentId: story.id });
    const closed = await create({ kind: 'bug', title: 'a closed record', parentId: story.id });
    await adminDb.workItem.update({ where: { id: closed.id }, data: { status: 'done' } });

    const histogram = async () => {
      const rows = await adminDb.workItem.findMany({
        where: { id: { in: [open.id, closed.id] } },
        select: { status: true },
        orderBy: { status: 'asc' },
      });
      return rows.map((r) => r.status);
    };
    const statusesBefore = await histogram();
    const storyStatusBefore = (
      await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })
    ).status;

    await runMigration();

    const planning = await adminDb.folder.findFirstOrThrow({
      where: { projectId: t.projectId, name: 'Planning bugs' },
    });
    expect(planning.parentFolderId).toBe(bugs);
    expect((await pointers(t.projectId)).planner).toBe(planning.id);

    expect(await adminDb.workItem.count({ where: { parentId: story.id } })).toBe(0);
    for (const id of [open.id, closed.id]) {
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
      expect(row.folderId).toBe(planning.id);
      expect(row.parentId).toBeNull();
    }

    const archived = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.status).toBe(storyStatusBefore); // ARCHIVED, never closed
    expect(await histogram()).toEqual(statusesBefore);
  });

  it('and the MIGRATED destination is the one the filer then reads — the join the units cannot see', async () => {
    const t = await makeTenant('migration-filer', 'PGMGF');
    await workItemsService.createWorkItem(
      { projectId: t.projectId, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      t.ctx,
    );

    await runMigration();

    const planning = await adminDb.folder.findFirstOrThrow({
      where: { projectId: t.projectId, name: 'Planning bugs' },
    });
    const filed = await filePlanningBug(t.projectKey, 'filed after the migration ran');

    expect(filed.folderId).toBe(planning.id);
    expect(filed.parentId).toBeNull();
  });
});
