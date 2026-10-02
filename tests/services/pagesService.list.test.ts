import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pagesService.listPages` on real Postgres (Story MOTIR-5752 · MOTIR-7300) — the
// `/pages` index's read: newest edit first, never a page from another project,
// readable by a Viewer, refused to a non-member, and each row naming who edited
// it last.

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
    email: `pages-list-${tag}@example.com`,
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

/** Pin a page's last-edit instant, so the order under test is not a clock race. */
async function editedAt(pageId: string, iso: string) {
  await adminDb.page.update({ where: { id: pageId }, data: { updatedAt: new Date(iso) } });
}

describe('pagesService.listPages', () => {
  it('lists the project’s pages most recently edited first, each with its last editor', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const spec = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Spec',
    });
    const runbook = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Runbook',
    });
    const blank = await pagesService.createPage(f.manager, { projectId: f.projectId });
    // The member renames the OLDEST page — it becomes theirs as the last editor.
    await pagesService.renamePage(member, {
      projectId: f.projectId,
      pageId: spec.id,
      title: 'Spec v2',
    });
    await editedAt(spec.id, '2026-10-01T12:00:00.000Z');
    await editedAt(runbook.id, '2026-09-20T12:00:00.000Z');
    await editedAt(blank.id, '2026-09-30T12:00:00.000Z');

    const rows = await pagesService.listPages(member, { projectId: f.projectId });

    expect(rows).toEqual([
      {
        id: spec.id,
        title: 'Spec v2',
        updatedAt: '2026-10-01T12:00:00.000Z',
        updatedBy: { id: member.userId, name: 'Pages member' },
      },
      {
        id: blank.id,
        title: '',
        updatedAt: '2026-09-30T12:00:00.000Z',
        updatedBy: { id: f.manager.userId, name: 'Pages owner' },
      },
      {
        id: runbook.id,
        title: 'Runbook',
        updatedAt: '2026-09-20T12:00:00.000Z',
        updatedBy: { id: f.manager.userId, name: 'Pages owner' },
      },
    ]);
  });

  it('never returns a page from another project of the same workspace', async () => {
    const f = await makeFixture();
    const here = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Here',
    });
    const there = await pagesService.createPage(f.manager, {
      projectId: f.otherProjectId,
      title: 'There',
    });

    const listedHere = await pagesService.listPages(f.manager, { projectId: f.projectId });
    const listedThere = await pagesService.listPages(f.manager, { projectId: f.otherProjectId });

    expect(listedHere.map((r) => r.id)).toEqual([here.id]);
    expect(listedThere.map((r) => r.id)).toEqual([there.id]);
  });

  it('answers an empty list for a project with no pages', async () => {
    const f = await makeFixture();
    await pagesService.createPage(f.manager, { projectId: f.otherProjectId, title: 'Elsewhere' });
    expect(await pagesService.listPages(f.manager, { projectId: f.projectId })).toEqual([]);
  });

  it('a Viewer reads the list', async () => {
    const f = await makeFixture();
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const page = await pagesService.createPage(f.manager, {
      projectId: f.projectId,
      title: 'Spec',
    });

    const rows = await pagesService.listPages(viewer, { projectId: f.projectId });
    expect(rows.map((r) => r.id)).toEqual([page.id]);
  });

  it('a non-member is refused as `browse`', async () => {
    const f = await makeFixture();
    await pagesService.createPage(f.manager, { projectId: f.projectId, title: 'Spec' });
    const outsider = await makeUser('outsider');

    const err = await pagesService
      .listPages({ userId: outsider.id, workspaceId: f.workspaceId }, { projectId: f.projectId })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('browse');
  });
});
