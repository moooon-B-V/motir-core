import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  PageNotFoundError,
  PageParentNotAllowedError,
  PageRevisionConflictError,
  markdownToUpdate,
  parseMarkdown,
  serializeMarkdown,
} from '@/lib/pages';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pagesService`'s markdown doors on real Postgres (Story MOTIR-5760 ·
// MOTIR-7409): the agent's read under `page:view`, the whole-body write and the
// create-with-body under `page:edit`, each in one transaction.

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
  managerName: string;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-md-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Markdown ${tag}`,
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
    managerName: 'Markdown owner',
  };
}

async function memberAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<ServiceContext> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { userId: user.id, workspaceId: f.workspaceId };
}

const versionCount = (pageId: string) => adminDb.pageVersion.count({ where: { pageId } });

const BODY = [
  '# Runbook',
  '',
  '- [ ] check the logs',
  '- [x] page the owner',
  '',
  '```sh',
  'pnpm test',
  '```',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

describe('pagesService.getPageMarkdown', () => {
  it('reads an editor-written page as its markdown column, with placement, revision and newest version', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Spec',
    });
    const page = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    await pagesService.savePageUpdate(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(new Uint8Array(page.bodyState), BODY),
    });
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });

    const read = await pagesService.getPageMarkdown(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
    });

    expect(read).toMatchObject({
      id: created.id,
      projectId: f.projectId,
      title: 'Spec',
      placement: { parentPageId: null, folderId: null },
      revision: 2,
      markdown: stored.bodyMarkdown,
      latestVersion: { number: 1, authorId: f.manager.userId, authorName: f.managerName },
    });
    expect(read.markdown).toContain('# Runbook');
    expect(read).not.toHaveProperty('bodyState');
    expect(Number.isNaN(Date.parse(read.updatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(read.latestVersion!.savedAt))).toBe(false);
  });

  it('returns a null latestVersion for a page whose history predates versions', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await adminDb.pageVersion.deleteMany({ where: { pageId: created.id } });
    const read = await pagesService.getPageMarkdown(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(read.latestVersion).toBeNull();
    expect(read.markdown).toBe('');
  });

  it('a page from another project, or an unknown id, is not found — read and write alike', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });
    for (const pageId of [elsewhere.id, 'no-such-page']) {
      await expect(
        pagesService.getPageMarkdown(f.manager, { projectId: f.projectId, pageId }),
      ).rejects.toBeInstanceOf(PageNotFoundError);
      await expect(
        pagesService.savePageMarkdown(f.manager, {
          projectId: f.projectId,
          pageId,
          markdown: 'x',
          expectedRevision: 1,
        }),
      ).rejects.toBeInstanceOf(PageNotFoundError);
    }
    const untouched = await adminDb.page.findUniqueOrThrow({ where: { id: elsewhere.id } });
    expect(untouched).toMatchObject({ revision: 1, bodyMarkdown: '' });
  });

  it('a non-member is refused as `browse`, as getPage refuses them', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    const stranger = await makeUser('stranger');
    const err = await pagesService
      .getPageMarkdown(
        { userId: stranger.id, workspaceId: f.workspaceId },
        { projectId: f.projectId, pageId: created.id },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('browse');
  });

  it('a Viewer reads, and is refused both markdown writes as `edit`', async () => {
    const f = await makeFixture();
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });

    const read = await pagesService.getPageMarkdown(viewer, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(read.id).toBe(created.id);

    const refusals = [
      () =>
        pagesService.savePageMarkdown(viewer, {
          projectId: f.projectId,
          pageId: created.id,
          markdown: 'nope',
          expectedRevision: 1,
        }),
      () =>
        pagesService.createPageFromMarkdown(viewer, { projectId: f.projectId, markdown: 'nope' }),
    ];
    for (const refusal of refusals) {
      const err = await refusal().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    }
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(1);
  });
});

describe('pagesService.savePageMarkdown', () => {
  it('writes at the current revision and returns the page read back', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });

    const saved = await pagesService.savePageMarkdown(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      markdown: BODY,
      expectedRevision: 1,
    });

    expect(saved.revision).toBe(2);
    expect(saved.markdown).toBe(serializeMarkdown(parseMarkdown(BODY)));
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ revision: 2, bodyMarkdown: saved.markdown });
    expect(saved.latestVersion).toMatchObject({ number: 1, authorId: f.manager.userId });
  });

  it('refuses a stale revision by name and leaves the body and revision as they were', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.manager, { projectId: f.projectId });
    await pagesService.savePageMarkdown(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
      markdown: 'A person wrote this.',
      expectedRevision: 1,
    });

    const err = await pagesService
      .savePageMarkdown(f.manager, {
        projectId: f.projectId,
        pageId: created.id,
        markdown: 'An agent overwrote it.',
        expectedRevision: 1,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(PageRevisionConflictError);
    expect(err).toMatchObject({ code: 'PAGE_REVISION_CONFLICT', expected: 1, actual: 2 });
    const reread = await pagesService.getPageMarkdown(f.manager, {
      projectId: f.projectId,
      pageId: created.id,
    });
    expect(reread).toMatchObject({ revision: 2, markdown: 'A person wrote this.' });
  });
});

describe('pagesService.createPageFromMarkdown', () => {
  it('files the page at the root, in a folder and under a page, each with its body and ONE version', async () => {
    const f = await makeFixture();
    const folder = await adminDb.folder.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        parentFolderId: null,
        name: 'Docs',
        position: 'a0',
        createdById: f.manager.userId,
      },
    });

    const atRoot = await pagesService.createPageFromMarkdown(f.manager, {
      projectId: f.projectId,
      title: 'Root',
      markdown: BODY,
    });
    const inFolder = await pagesService.createPageFromMarkdown(f.manager, {
      projectId: f.projectId,
      title: 'Filed',
      parent: { kind: 'folder', id: folder.id },
      markdown: '# Filed',
    });
    const underPage = await pagesService.createPageFromMarkdown(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'page', id: atRoot.id },
      markdown: 'Child body.',
    });

    expect(atRoot).toMatchObject({
      title: 'Root',
      placement: { parentPageId: null, folderId: null },
      revision: 2,
      markdown: serializeMarkdown(parseMarkdown(BODY)),
      latestVersion: { number: 1, authorId: f.manager.userId },
    });
    expect(inFolder).toMatchObject({
      placement: { parentPageId: null, folderId: folder.id },
      markdown: '# Filed',
    });
    expect(underPage).toMatchObject({
      title: '',
      placement: { parentPageId: atRoot.id, folderId: null },
      markdown: 'Child body.',
    });
    for (const page of [atRoot, inFolder, underPage]) {
      const stored = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
      expect(stored.bodyMarkdown).toBe(page.markdown);
      expect(await versionCount(page.id)).toBe(1);
      const [version] = await adminDb.pageVersion.findMany({ where: { pageId: page.id } });
      expect(version!.bodyMarkdown).toBe(page.markdown);
    }
  });

  it('without markdown the page is empty at revision 1, as New page makes it', async () => {
    const f = await makeFixture();
    for (const markdown of [undefined, '']) {
      const page = await pagesService.createPageFromMarkdown(f.manager, {
        projectId: f.projectId,
        markdown,
      });
      expect(page).toMatchObject({ revision: 1, markdown: '', latestVersion: { number: 1 } });
      expect(await versionCount(page.id)).toBe(1);
    }
  });

  it('refuses a work-item parent and leaves no page behind', async () => {
    const f = await makeFixture();
    await expect(
      pagesService.createPageFromMarkdown(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'work_item', id: 'x' },
        markdown: 'Orphan.',
      }),
    ).rejects.toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED' });
    await expect(
      pagesService.createPageFromMarkdown(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'work_item', id: 'x' },
      }),
    ).rejects.toBeInstanceOf(PageParentNotAllowedError);
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(0);
  });

  it('rolls the page back when its body is refused', async () => {
    const f = await makeFixture();
    const tooBig = 'é'.repeat(600_000);
    await expect(
      pagesService.createPageFromMarkdown(f.manager, {
        projectId: f.projectId,
        title: 'Doomed',
        markdown: tooBig,
      }),
    ).rejects.toMatchObject({ code: 'PAGE_BODY_TOO_LARGE' });
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(0);
  });
});
