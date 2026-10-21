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
// one row per linking page with its sorted sources and place, keyset paging at
// 50 (capped at 100), an archived page served as an `unavailable` row
// (MOTIR-9203), and the three refusals — no
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

  const archive = (pageId: string) =>
    pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId });

  it('serves an archived page as an unavailable row, live again after restore, gone on delete', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const page = await newPage('Kept');
    await link(page.id, target.id, 'manual');
    await link(page.id, target.id, 'mention');

    const live = (await list(fx.ctx, target.id)).rows;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ pageId: page.id, title: 'Kept', state: 'live' });

    await archive(page.id);
    const archived = (await list(fx.ctx, target.id)).rows;
    expect(archived).toHaveLength(1);
    // Archiving changes whether the page opens, not what the link was.
    expect(archived[0]).toMatchObject({
      pageId: page.id,
      title: 'Kept',
      sources: ['manual', 'mention'],
      state: 'unavailable',
    });
    expect(archived[0]?.place).toEqual(live[0]?.place);

    await pagesService.restorePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    const restored = (await list(fx.ctx, target.id)).rows;
    expect(restored.map((r) => [r.pageId, r.state])).toEqual([[page.id, 'live']]);

    // A deleted page has no row at all — the FK cascade takes its link rows.
    await archive(page.id);
    await pagesService.deletePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect((await list(fx.ctx, target.id)).rows).toEqual([]);
    expect(await adminDb.pageWorkItemLink.count({ where: { workItemId: target.id } })).toBe(0);
  });

  it('keeps one ordering in a mixed window: the archived page takes its place by updatedAt', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const a = await newPage('A');
    const b = await newPage('B');
    const c = await newPage('C');
    for (const p of [a, b, c]) await link(p.id, target.id, 'mention');
    await archive(b.id);
    // Stamped after the archive, so the order does not rest on what archiving does to it.
    await adminDb.page.update({
      where: { id: a.id },
      data: { updatedAt: new Date('2026-01-03Z') },
    });
    await adminDb.page.update({
      where: { id: b.id },
      data: { updatedAt: new Date('2026-01-02Z') },
    });
    await adminDb.page.update({
      where: { id: c.id },
      data: { updatedAt: new Date('2026-01-01Z') },
    });

    const { rows } = await list(fx.ctx, target.id);
    expect(rows.map((r) => [r.pageId, r.state])).toEqual([
      [a.id, 'live'],
      [b.id, 'unavailable'],
      [c.id, 'live'],
    ]);
    const times = rows.map((r) => Date.parse(r.updatedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('pages across an archived row without repeating or skipping a page', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const pages = [await newPage('P0'), await newPage('P1'), await newPage('P2')];
    for (const p of pages) await link(p.id, target.id, 'mention');
    const stamps = ['2026-01-03Z', '2026-01-02Z', '2026-01-01Z'];
    await archive(pages[1]!.id);
    for (const [i, p] of pages.entries()) {
      await adminDb.page.update({ where: { id: p.id }, data: { updatedAt: new Date(stamps[i]!) } });
    }

    const first = await list(fx.ctx, target.id, null, 2);
    expect(first.rows.map((r) => r.pageId)).toEqual([pages[0]!.id, pages[1]!.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(fx.ctx, target.id, first.nextCursor, 2);
    expect(second.rows.map((r) => r.pageId)).toEqual([pages[2]!.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('still resolves the place of an archived page', async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Specs' },
      fx.ctx,
    );
    const top = await newPage('Plan', { kind: 'folder', id: folder.id });
    const child = await newPage('Child', { kind: 'page', id: top.id });
    await link(child.id, target.id, 'manual');
    await archive(child.id);

    const { rows } = await list(fx.ctx, target.id);
    expect(rows[0]).toMatchObject({
      state: 'unavailable',
      place: { folderPath: ['Specs'], parentPageTitle: 'Plan' },
    });
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
