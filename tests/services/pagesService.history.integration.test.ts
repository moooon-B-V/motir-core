import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  PAGE_BODY_MAX_BYTES,
  PageBodyTooLargeError,
  PageNotFoundError,
  PageVersionNotFoundError,
  applyUpdate,
  emptyState,
  markdownToUpdate,
  stateToMarkdown,
} from '@/lib/pages';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pagesService`'s history methods on real Postgres (Story MOTIR-5754 ·
// MOTIR-7385): list and get under `page:view`, restore under `page:edit`, and a
// restore racing a save proved with real parallel transactions.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: ServiceContext;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-hist-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `History ${tag}`,
  });
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'Pages', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Pages',
    identifier: 'PGS',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OTH',
  });
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    manager: { userId: owner.id, workspaceId },
  };
}

async function memberAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<ServiceContext> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { userId: user.id, workspaceId: f.workspaceId };
}

/** Moves a page's versions outside the coalescing window, so the next save starts its own. */
async function ageVersions(pageId: string) {
  await adminDb.pageVersion.updateMany({
    where: { pageId },
    data: { startedAt: new Date(0), savedAt: new Date(0) },
  });
}

/** A page with versions 1 (empty) and 2 ("First"), both by the manager. */
async function pageWithTwoVersions(f: Fixture) {
  const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
  await ageVersions(created.id);
  await pagesService.savePageUpdate(f.manager, {
    projectId: f.projectId,
    pageId: created.id,
    update: markdownToUpdate(emptyState(), 'First'),
  });
  return created.id;
}

/** Appends versions straight to the table, numbered after the page's newest. */
async function appendVersions(f: Fixture, pageId: string, count: number, state?: Uint8Array) {
  const latest = await adminDb.pageVersion.findFirstOrThrow({
    where: { pageId },
    orderBy: { number: 'desc' },
  });
  const at = new Date(latest.savedAt.getTime() + 60 * 60 * 1000);
  await adminDb.pageVersion.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      pageId,
      number: latest.number + i + 1,
      authorId: f.manager.userId,
      bodyState: state ? Buffer.from(state) : latest.bodyState,
      bodyMarkdown: state ? stateToMarkdown(state) : latest.bodyMarkdown,
      startedAt: at,
      savedAt: at,
    })),
  });
}

const versionCount = (pageId: string) => adminDb.pageVersion.count({ where: { pageId } });

describe('pagesService — listPageVersions', () => {
  it('pages 120 versions newest first as 50 / 50 / 20, each with its author', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await appendVersions(f, created.id, 119);

    const first = await pagesService.listPageVersions(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({
      number: 120,
      isCurrent: true,
      authorId: f.manager.userId,
      authorName: 'History owner',
      restoredFromNumber: null,
      restoredFromKept: false,
    });
    expect(first.items.slice(1).every((v) => !v.isCurrent)).toBe(true);
    expect(first.nextBefore).toBe(71);

    const second = await pagesService.listPageVersions(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      before: first.nextBefore!,
    });
    expect(second.items.map((v) => v.number)).toEqual(Array.from({ length: 50 }, (_, i) => 70 - i));
    expect(second.nextBefore).toBe(21);

    const third = await pagesService.listPageVersions(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      before: second.nextBefore!,
    });
    expect(third.items.map((v) => v.number)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
    expect(third.nextBefore).toBeNull();
  });

  it('caps a page at 100 whatever the caller asks for', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await appendVersions(f, created.id, 119);

    const page = await pagesService.listPageVersions(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      limit: 500,
    });
    expect(page.items).toHaveLength(100);
    expect(page.nextBefore).toBe(21);
  });
});

describe('pagesService — history access', () => {
  it('a Viewer lists and reads a version, and is refused a restore with nothing written', async () => {
    const f = await makeFixture();
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const pageId = await pageWithTwoVersions(f);

    const list = await pagesService.listPageVersions(viewer, { projectId: f.projectId, pageId });
    expect(list.items.map((v) => v.number)).toEqual([2, 1]);

    const v2 = await pagesService.getPageVersion(viewer, {
      projectId: f.projectId,
      pageId,
      number: 2,
    });
    expect(v2).toMatchObject({ number: 2, isCurrent: true });
    expect(stateToMarkdown(new Uint8Array(Buffer.from(v2.bodyState, 'base64')))).toBe('First');

    const before = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
    const err = await pagesService
      .restorePageVersion(viewer, { projectId: f.projectId, pageId, number: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect(err).toMatchObject({ kind: 'edit' });

    const after = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
    expect(after.revision).toBe(before.revision);
    expect(await versionCount(pageId)).toBe(2);
  });

  it('a page from another project is PageNotFoundError on all three', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    const elsewhere = { projectId: f.otherProjectId, pageId };

    await expect(pagesService.listPageVersions(f.manager, elsewhere)).rejects.toBeInstanceOf(
      PageNotFoundError,
    );
    await expect(
      pagesService.getPageVersion(f.manager, { ...elsewhere, number: 1 }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(
      pagesService.restorePageVersion(f.manager, { ...elsewhere, number: 1 }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  });

  it('an unknown version number is PageVersionNotFoundError on get and restore', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);

    await expect(
      pagesService.getPageVersion(f.manager, { projectId: f.projectId, pageId, number: 9 }),
    ).rejects.toBeInstanceOf(PageVersionNotFoundError);
    await expect(
      pagesService.restorePageVersion(f.manager, { projectId: f.projectId, pageId, number: 9 }),
    ).rejects.toBeInstanceOf(PageVersionNotFoundError);
    expect(await versionCount(pageId)).toBe(2);
  });
});

describe('pagesService — restorePageVersion', () => {
  it('restoring v1 records a new current version whose content is v1', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'editor', 'member');
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await ageVersions(created.id);
    await pagesService.savePageUpdate(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(emptyState(), 'Draft'),
    });
    // v1 is the empty page and v2 "Draft"; a member's save then lands as v3.
    const current = new Uint8Array(
      (await adminDb.page.findUniqueOrThrow({ where: { id: created.id } })).bodyState,
    );
    await pagesService.savePageUpdate(member, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(current, 'Draft, edited'),
    });
    const v1 = await pagesService.getPageVersion(member, {
      projectId: f.projectId,
      pageId: created.id,
      number: 1,
    });

    const restored = await pagesService.restorePageVersion(member, {
      projectId: f.projectId,
      pageId: created.id,
      number: 1,
    });

    expect(restored.version).toMatchObject({
      restoredFromNumber: 1,
      restoredFromKept: true,
      isCurrent: true,
      authorId: member.userId,
      authorName: 'History editor',
    });
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    expect(restored.revision).toBe(stored.revision);
    const body = stateToMarkdown(new Uint8Array(Buffer.from(restored.bodyState, 'base64')));
    expect(body).toBe(stateToMarkdown(new Uint8Array(Buffer.from(v1.bodyState, 'base64'))));
    expect(stored.bodyMarkdown).toBe(body);

    const list = await pagesService.listPageVersions(member, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(list.items[0]).toMatchObject({ number: restored.version.number, isCurrent: true });
    expect(list.items.filter((v) => v.isCurrent)).toHaveLength(1);
  });

  it('refuses a restore past the body limit and changes nothing', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    const huge = applyUpdate(
      emptyState(),
      markdownToUpdate(emptyState(), 'x'.repeat(PAGE_BODY_MAX_BYTES + 1024)),
    );
    await appendVersions(f, pageId, 1, huge);
    // Make v3 the oversized source, and v4 the small current content.
    await appendVersions(f, pageId, 1, emptyState());
    const before = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
    const count = await versionCount(pageId);

    await expect(
      pagesService.restorePageVersion(f.manager, { projectId: f.projectId, pageId, number: 3 }),
    ).rejects.toBeInstanceOf(PageBodyTooLargeError);

    const after = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
    expect(after.revision).toBe(before.revision);
    expect(Buffer.compare(Buffer.from(after.bodyState), Buffer.from(before.bodyState))).toBe(0);
    expect(await versionCount(pageId)).toBe(count);
  });
});

describe('pagesService — restore against a save, with real parallel transactions', () => {
  it('both commit on distinct version numbers, in either order', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'racer', 'member');
    const pageId = await pageWithTwoVersions(f);
    const base = new Uint8Array(
      (await adminDb.page.findUniqueOrThrow({ where: { id: pageId } })).bodyState,
    );

    const [restored, saved] = await Promise.all([
      pagesService.restorePageVersion(f.manager, { projectId: f.projectId, pageId, number: 1 }),
      pagesService.savePageUpdate(member, {
        projectId: f.projectId,
        pageId,
        update: markdownToUpdate(base, 'First\n\nSecond'),
      }),
    ]);

    // Each write locks the page, so the two serialise: revisions 3 and 4 in some order.
    expect([restored.revision, saved.revision].sort()).toEqual([3, 4]);
    const versions = await adminDb.pageVersion.findMany({
      where: { pageId },
      orderBy: { number: 'asc' },
    });
    expect(versions.map((v) => v.number)).toEqual([1, 2, 3, 4]);
    const restore = versions.find((v) => v.restoredFromNumber === 1)!;
    const save = versions.find((v) => v.authorId === member.userId)!;
    expect(restore.number).not.toBe(save.number);

    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
    if (restored.revision > saved.revision) {
      // The restore landed last: the page is v1's content again, and the
      // member's edit survives as its own version.
      expect(stored.bodyMarkdown).toBe('');
      expect(save.bodyMarkdown).toBe('First\n\nSecond');
    } else {
      // The save landed last: its edit merges onto the restored content.
      expect(stored.bodyMarkdown.trim()).toBe('Second');
    }
  });
});
