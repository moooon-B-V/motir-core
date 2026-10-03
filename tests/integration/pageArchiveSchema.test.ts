import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PAGE ARCHIVE COLUMNS — MOTIR-7417 (Story MOTIR-5755, Epic MOTIR-5746).
//
// Proves, on real Postgres, what `20261003100000_page_archive` makes the
// DATABASE do, independent of any service: the `page_archive_pairing` CHECK in
// both directions, `archived_by_id`'s SET NULL leaving the page archived, the
// two partial indexes as `pg_indexes` reports them, and that a page written
// without the columns reads live. `pageVersionSchema.test.ts` is the shape.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BODY = Uint8Array.from([1, 2, 3, 4]);
const EMPTY_DOC = { type: 'doc', content: [] };

async function makeTenant() {
  const owner = await usersService.createUser({
    email: 'pa-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Archive Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'PA W', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'PA P',
    identifier: 'PAONE',
  });
  return { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

let counter = 0;
async function makePage(t: { workspaceId: string; projectId: string; userId: string }) {
  counter += 1;
  return adminDb.page.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      createdById: t.userId,
      updatedById: t.userId,
      title: `Page ${counter}`,
      position: `a${counter.toString(36)}`,
      bodyState: BODY,
      bodyJson: EMPTY_DOC,
    },
  });
}

describe('page archive columns (MOTIR-7417)', () => {
  it('a page written without them reads live: both archive columns null', async () => {
    const t = await makeTenant();
    const page = await makePage(t);
    const read = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(read.archivedAt).toBeNull();
    expect(read.archiveRootId).toBeNull();
    expect(read.archivedById).toBeNull();
  });

  it('refuses archived_at without archive_root_id, on INSERT and on UPDATE', async () => {
    const t = await makeTenant();
    await expect(
      adminDb.page.create({
        data: {
          workspaceId: t.workspaceId,
          projectId: t.projectId,
          createdById: t.userId,
          updatedById: t.userId,
          position: 'a0',
          bodyState: BODY,
          bodyJson: EMPTY_DOC,
          archivedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/page_archive_pairing/);
    const page = await makePage(t);
    await expect(
      adminDb.page.update({ where: { id: page.id }, data: { archivedAt: new Date() } }),
    ).rejects.toThrow(/page_archive_pairing/);
  });

  it('refuses archive_root_id without archived_at, on INSERT and on UPDATE', async () => {
    const t = await makeTenant();
    await expect(
      adminDb.page.create({
        data: {
          workspaceId: t.workspaceId,
          projectId: t.projectId,
          createdById: t.userId,
          updatedById: t.userId,
          position: 'a0',
          bodyState: BODY,
          bodyJson: EMPTY_DOC,
          archiveRootId: 'some-root',
        },
      }),
    ).rejects.toThrow(/page_archive_pairing/);
    const page = await makePage(t);
    await expect(
      adminDb.page.update({ where: { id: page.id }, data: { archiveRootId: page.id } }),
    ).rejects.toThrow(/page_archive_pairing/);
  });

  it('accepts both set, and both cleared again (archive, then restore)', async () => {
    const t = await makeTenant();
    const page = await makePage(t);
    const at = new Date('2026-10-03T10:00:00.000Z');
    const archived = await adminDb.page.update({
      where: { id: page.id },
      data: { archivedAt: at, archiveRootId: page.id, archivedById: t.userId },
    });
    expect(archived.archivedAt?.toISOString()).toBe(at.toISOString());
    expect(archived.archiveRootId).toBe(page.id);
    // The page's own place is untouched — it IS where a restore returns it.
    expect(archived.position).toBe(page.position);
    const live = await adminDb.page.update({
      where: { id: page.id },
      data: { archivedAt: null, archiveRootId: null, archivedById: null },
    });
    expect(live.archivedAt).toBeNull();
    expect(live.archiveRootId).toBeNull();
  });

  it('deleting the archiver nulls archived_by_id and leaves the page archived', async () => {
    const t = await makeTenant();
    const archiver = await usersService.createUser({
      email: 'pa-archiver@example.com',
      password: 'hunter2hunter2',
      name: 'Archiver',
    });
    const page = await makePage(t);
    const at = new Date('2026-10-03T11:00:00.000Z');
    await adminDb.page.update({
      where: { id: page.id },
      data: { archivedAt: at, archiveRootId: page.id, archivedById: archiver.id },
    });
    await adminDb.user.delete({ where: { id: archiver.id } });
    const read = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(read.archivedById).toBeNull();
    expect(read.archivedAt?.toISOString()).toBe(at.toISOString());
    expect(read.archiveRootId).toBe(page.id);
  });

  it('creates the two partial indexes with their columns and predicates', async () => {
    const rows = await adminDb.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'page'
         AND indexname IN ('page_archived_roots_idx', 'page_archive_root_idx')
       ORDER BY indexname`;
    expect(rows.map((r) => r.indexname)).toEqual([
      'page_archive_root_idx',
      'page_archived_roots_idx',
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.page_archived_roots_idx).toContain(
      '(project_id, archived_at DESC, id DESC) WHERE (archive_root_id = id)',
    );
    expect(byName.page_archive_root_idx).toContain(
      '(archive_root_id) WHERE (archive_root_id IS NOT NULL)',
    );
  });
});
