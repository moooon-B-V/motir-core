import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  PageLevelCursorInvalidError,
  pageStoreFor,
  savePageMarkdown,
  systemClock,
} from '@/lib/pages';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { foldersService } from '@/lib/services/foldersService';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// The work item's Pages read on real Postgres (Story MOTIR-7565 · MOTIR-7573):
// one row per live page with its sorted sources and place, keyset paging at 50
// (capped at 100), archived pages left out, and the three refusals — no
// `page:view`, a work item the reader cannot see, and a Visitor.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PGL' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const newPage = async (title: string, parent?: { kind: 'folder' | 'page'; id: string }) =>
  pagesService.createPage(fx.ctx, { projectId: fx.projectId, title, parent });

const link = (pageId: string, workItemId: string, source: 'mention' | 'embed' | 'manual') =>
  adminDb.pageWorkItemLink.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      pageId,
      workItemId,
      source,
      createdById: fx.ownerId,
    },
  });

const list = (ctx: ServiceContext, workItemId: string, cursor?: string | null, limit?: number) =>
  pageLinksService.listPagesForWorkItem(ctx, { workItemId, cursor, limit });

async function reader(email: string): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('pageLinksService.listPagesForWorkItem', () => {
  it('returns one row per page with its sorted sources, title, updatedAt and place', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Specs' },
      fx.ctx,
    );
    const p = await newPage('Plan', { kind: 'folder', id: folder.id });
    const q = await newPage('Notes');
    const child = await newPage('Child', { kind: 'page', id: p.id });

    // P by a mention written through a real save, plus a hand link.
    await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) =>
        savePageMarkdown(pageStoreFor(tx), systemClock, {
          pageId: p.id,
          actorId: fx.ownerId,
          markdown: `See [K](motir:${target.id}).`,
          expectedRevision: 1,
        }),
    );
    await link(p.id, target.id, 'manual');
    await link(q.id, target.id, 'embed');
    await link(child.id, target.id, 'mention');

    const { rows, nextCursor } = await list(fx.ctx, target.id);
    expect(nextCursor).toBeNull();
    const byId = new Map(rows.map((r) => [r.pageId, r]));
    expect(rows).toHaveLength(3);
    expect(byId.get(p.id)).toMatchObject({
      title: 'Plan',
      sources: ['manual', 'mention'],
      place: { folderPath: ['Specs'], parentPageTitle: null },
    });
    expect(byId.get(q.id)).toMatchObject({
      title: 'Notes',
      sources: ['embed'],
      place: { folderPath: [], parentPageTitle: null },
    });
    // A sub-page follows its top page's folder and names its parent.
    expect(byId.get(child.id)).toMatchObject({
      sources: ['mention'],
      place: { folderPath: ['Specs'], parentPageTitle: 'Plan' },
    });
    for (const r of rows) expect(Number.isNaN(Date.parse(r.updatedAt))).toBe(false);
  });

  it('pages 120 linking pages as 50, 50, 20 in (updated_at, id) descending, none twice or skipped', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Popular' });
    const ids: string[] = [];
    for (let i = 0; i < 120; i += 1) ids.push((await newPage(`Page ${i}`)).id);
    await adminDb.pageWorkItemLink.createMany({
      data: ids.map((pageId) => ({
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId,
        workItemId: target.id,
        source: 'mention' as const,
      })),
    });
    // Ties in threes, so the id tie-break is exercised across page boundaries.
    const base = Date.UTC(2026, 0, 1);
    for (const [i, id] of ids.entries()) {
      await adminDb.page.update({
        where: { id },
        data: { updatedAt: new Date(base - Math.floor(i / 3) * 1000) },
      });
    }

    const first = await list(fx.ctx, target.id);
    const second = await list(fx.ctx, target.id, first.nextCursor);
    const third = await list(fx.ctx, target.id, second.nextCursor);
    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([50, 50, 20]);
    expect(third.nextCursor).toBeNull();

    const served = [...first.rows, ...second.rows, ...third.rows];
    expect(new Set(served.map((r) => r.pageId)).size).toBe(120);
    const expected = [...served].sort(
      (a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        (a.pageId < b.pageId ? 1 : a.pageId > b.pageId ? -1 : 0),
    );
    expect(served.map((r) => r.pageId)).toEqual(expected.map((r) => r.pageId));

    expect((await list(fx.ctx, target.id, null, 500)).rows).toHaveLength(100);
    expect((await list(fx.ctx, target.id, null, 7)).rows).toHaveLength(7);
  });

  it('leaves an archived page out, shows it again after restore, and drops it on delete', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const page = await newPage('Kept');
    await link(page.id, target.id, 'mention');

    await adminDb.page.update({
      where: { id: page.id },
      data: { archivedAt: new Date(), archiveRootId: page.id },
    });
    expect((await list(fx.ctx, target.id)).rows).toEqual([]);

    await adminDb.page.update({
      where: { id: page.id },
      data: { archivedAt: null, archiveRootId: null },
    });
    expect((await list(fx.ctx, target.id)).rows.map((r) => r.pageId)).toEqual([page.id]);

    await adminDb.pageVersion.deleteMany({ where: { pageId: page.id } });
    await adminDb.page.delete({ where: { id: page.id } });
    expect((await list(fx.ctx, target.id)).rows).toEqual([]);
  });

  it('refuses a reader without page:view as edit, naming no page', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const page = await newPage('Secret page title');
    await link(page.id, target.id, 'mention');
    const browseOnly = await createCustomRoleAs({
      ctx: fx.ctx,
      name: 'Browser',
      permissions: ['project:browse', 'work_item:view'],
    });
    const r = await reader('browse-only@example.com');
    await setProjectRoleDefinitionFor(r.userId, fx.projectId, {
      roleDefinitionId: browseOnly.id,
      role: 'member',
    });

    const refused = await list(r, target.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProjectAccessDeniedError);
    expect((refused as ProjectAccessDeniedError).kind).toBe('edit');
    expect(String((refused as Error).message)).not.toContain('Secret page title');
  });

  it('answers not-found for a work item the reader cannot see, an unknown id, and a Visitor', async () => {
    const priv = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PRIV',
    });
    await projectMembersService.setAccessMode({
      key: priv.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    const hidden = await createTestWorkItem(
      { ...fx, projectId: priv.id, projectIdentifier: 'PRIV' },
      { kind: 'task', title: 'Hidden' },
    );
    const outsider = await reader('outsider@example.com');

    await expect(list(outsider, hidden.id)).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(list(fx.ctx, 'ckunknownworkitem0000000')).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );

    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Public' });
    const page = await newPage('Visible to members');
    await link(page.id, target.id, 'mention');
    const visitor = { kind: 'visitor' } as unknown as VisitorReadContext;
    await expect(
      pageLinksService.listPagesForWorkItem(visitor, { workItemId: target.id }),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('refuses a cursor it did not issue', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    await expect(list(fx.ctx, target.id, 'not-a-cursor')).rejects.toBeInstanceOf(
      PageLevelCursorInvalidError,
    );
  });
});
