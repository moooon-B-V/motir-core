import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  PAGE_SAVE_MAX_BYTES,
  PageBodyTooLargeError,
  PageFolderNotFoundError,
  PageNotFoundError,
  PageParentNotAllowedError,
  PageTitleTooLongError,
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

// `pagesService` on real Postgres (Story MOTIR-5752 · MOTIR-7277): who may
// create, read, rename and save a page, and the two read-derived writes proved
// with real parallel transactions — no save lost, no two pages on one position.

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
    email: `pages-svc-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Pages ${tag}`,
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

const markdownOf = async (pageId: string) =>
  (await adminDb.page.findUniqueOrThrow({ where: { id: pageId } })).bodyMarkdown;

describe('pagesService — access', () => {
  it('a Member creates, saves and reads back the merged page at revision 2', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');

    const created = await pagesService.createPage(member, {
      projectId: f.projectId,
      title: ' Plan ',
    });
    expect(created).toMatchObject({ projectId: f.projectId, title: 'Plan', revision: 1 });

    const saved = await pagesService.savePageUpdate(member, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(emptyState(), '# Goals\n\n- [ ] ship'),
    });
    expect(saved).toEqual({ revision: 2 });

    const page = await pagesService.getPage(member, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(page).toMatchObject({ id: created.id, title: 'Plan', revision: 2, canEdit: true });
    expect(stateToMarkdown(new Uint8Array(Buffer.from(page.bodyState, 'base64')))).toBe(
      '# Goals\n\n- [ ] ship',
    );
    expect(Number.isNaN(Date.parse(page.updatedAt))).toBe(false);

    const renamed = await pagesService.renamePage(member, {
      projectId: f.projectId,
      pageId: created.id,
      title: 'Roadmap',
    });
    expect(renamed).toMatchObject({ id: created.id, title: 'Roadmap' });
  });

  it('a Manager holds both keys', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    const page = await pagesService.getPage(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(page).toMatchObject({ title: '', revision: 1, canEdit: true });
  });

  it('a Viewer reads with canEdit false and is refused every write as `edit`', async () => {
    const f = await makeFixture();
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const created = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Spec',
    });

    const page = await pagesService.getPage(viewer, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(page).toMatchObject({ id: created.id, title: 'Spec', canEdit: false });

    // Thunks, run one at a time: started together, a later refusal can reject
    // before the loop attaches its handler, which vitest reports as an
    // unhandled rejection and fails the run although every test passed.
    const refusals = [
      () => pagesService.createPage(viewer, { projectId: f.projectId }),
      () =>
        pagesService.renamePage(viewer, { projectId: f.projectId, pageId: created.id, title: 'x' }),
      () =>
        pagesService.savePageUpdate(viewer, {
          projectId: f.projectId,
          pageId: created.id,
          update: markdownToUpdate(emptyState(), 'nope'),
        }),
    ];
    for (const refusal of refusals) {
      const err = await refusal().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    }
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ title: 'Spec', revision: 1 });
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(1);
  });

  it('a non-member is refused as `browse`', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    const stranger = await makeUser('stranger');
    const ctx = { userId: stranger.id, workspaceId: f.workspaceId };

    const err = await pagesService
      .getPage(ctx, { projectId: f.projectId, pageId: created.id })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('browse');
  });

  it('a page from another project is indistinguishable from an unknown page', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });

    for (const pageId of [elsewhere.id, 'no-such-page']) {
      await expect(
        pagesService.getPage(f.manager, { projectId: f.projectId, pageId }),
      ).rejects.toBeInstanceOf(PageNotFoundError);
      await expect(
        pagesService.renamePage(f.manager, { projectId: f.projectId, pageId, title: 'x' }),
      ).rejects.toBeInstanceOf(PageNotFoundError);
      await expect(
        pagesService.savePageUpdate(f.manager, {
          projectId: f.projectId,
          pageId,
          update: markdownToUpdate(emptyState(), 'x'),
        }),
      ).rejects.toBeInstanceOf(PageNotFoundError);
    }
    const untouched = await adminDb.page.findUniqueOrThrow({ where: { id: elsewhere.id } });
    expect(untouched).toMatchObject({ title: '', revision: 1 });
  });

  it('binds the transaction to the project the call names, not a stale active one', async () => {
    const f = await makeFixture();
    // A context still carrying the OTHER project, as an active-project cookie can.
    const ctx = { ...f.manager, projectId: f.otherProjectId };
    const created = await pagesService.createPage(ctx, { projectId: f.projectId });
    expect(created.projectId).toBe(f.projectId);
    const page = await pagesService.getPage(ctx, { projectId: f.projectId, pageId: created.id });
    expect(page.id).toBe(created.id);
  });

  it('passes the package’s content refusals through unchanged', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await expect(
      pagesService.renamePage(f.manager, {
        projectId: f.projectId,
        pageId: created.id,
        title: 'x'.repeat(256),
      }),
    ).rejects.toBeInstanceOf(PageTitleTooLongError);
  });

  it('refuses an over-size update and leaves the stored row unchanged', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await pagesService.savePageUpdate(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(emptyState(), 'Kept'),
    });
    const before = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });

    await expect(
      pagesService.savePageUpdate(f.manager, {
        projectId: f.projectId,
        pageId: created.id,
        update: new Uint8Array(PAGE_SAVE_MAX_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(PageBodyTooLargeError);

    const after = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.revision).toBe(before.revision);
    expect(Buffer.compare(Buffer.from(after.bodyState), Buffer.from(before.bodyState))).toBe(0);
    expect(after.bodyMarkdown).toBe('Kept');
  });
});

describe('pagesService.createPage — under a parent (MOTIR-7370)', () => {
  it('places a page at the root by default, in a folder, and under a page', async () => {
    const f = await makeFixture();
    const folder = await adminDb.folder.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        name: 'Specs',
        position: 'a0',
        createdById: f.manager.userId,
      },
    });

    const atRoot = await pagesService.createPage(f.manager, { projectId: f.projectId });
    const explicitRoot = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'root' },
    });
    const filed = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Filed',
      parent: { kind: 'folder', id: folder.id },
    });
    const sub = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'page', id: filed.id },
    });

    const row = (id: string) =>
      adminDb.page.findUniqueOrThrow({
        where: { id },
        select: { parentPageId: true, folderId: true, ancestorPageIds: true },
      });
    const root = { parentPageId: null, folderId: null, ancestorPageIds: [] };
    expect(await row(atRoot.id)).toEqual(root);
    expect(await row(explicitRoot.id)).toEqual(root);
    expect(atRoot.position < explicitRoot.position).toBe(true);
    expect(await row(filed.id)).toEqual({
      parentPageId: null,
      folderId: folder.id,
      ancestorPageIds: [],
    });
    expect(await row(sub.id)).toEqual({
      parentPageId: filed.id,
      folderId: null,
      ancestorPageIds: [filed.id],
    });
  });

  it('refuses a work item as the parent with PAGE_PARENT_NOT_ALLOWED, writing nothing', async () => {
    const f = await makeFixture();
    const err = await pagesService
      .createPage(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'work_item', id: 'some-work-item' },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PageParentNotAllowedError);
    expect(err).toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED', status: 422 });
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(0);
  });

  it('refuses a missing parent page or folder as not found', async () => {
    const f = await makeFixture();
    await expect(
      pagesService.createPage(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'page', id: 'no-such-page' },
      }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(
      pagesService.createPage(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'folder', id: 'no-such-folder' },
      }),
    ).rejects.toBeInstanceOf(PageFolderNotFoundError);
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(0);
  });
});

describe('pagesService — concurrency, with real parallel transactions', () => {
  it('two saves fired at once both commit, and the state holds both edits', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'writer', 'member');
    const created = await pagesService.createPage(member, { projectId: f.projectId });
    await pagesService.savePageUpdate(member, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(emptyState(), 'Alpha\n\nBeta'),
    });
    const base = new Uint8Array(
      (await adminDb.page.findUniqueOrThrow({ where: { id: created.id } })).bodyState,
    );

    const revisions = await Promise.all([
      pagesService.savePageUpdate(f.manager, {
        projectId: f.projectId,
        pageId: created.id,
        update: markdownToUpdate(base, 'Alpha one\n\nBeta'),
      }),
      pagesService.savePageUpdate(member, {
        projectId: f.projectId,
        pageId: created.id,
        update: markdownToUpdate(base, 'Alpha\n\nBeta two'),
      }),
    ]);

    expect(revisions.map((r) => r.revision).sort()).toEqual([3, 4]);
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.revision).toBe(4);
    expect(await markdownOf(created.id)).toBe('Alpha one\n\nBeta two');
    expect(stateToMarkdown(new Uint8Array(stored.bodyState))).toBe('Alpha one\n\nBeta two');
  });

  it('creates fired at once at the root all commit, on distinct positions', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'creator', 'member');
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pagesService.createPage(i % 2 ? member : f.manager, {
          projectId: f.projectId,
          title: `P${i}`,
        }),
      ),
    );
    const positions = created.map((p) => p.position);
    expect(new Set(positions).size).toBe(created.length);
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(6);
  });
});
