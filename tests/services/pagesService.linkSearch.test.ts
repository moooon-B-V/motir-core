import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { db } from '@/lib/db';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { encodePageTitleSearchCursor } from '@/lib/pages/pageTitleSearchCursor';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService, PAGE_MENTION_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// The Link page picker's paged title search on real Postgres (Story MOTIR-7567 ·
// MOTIR-9204): the page window, the look-ahead cursor, the stable order across
// pages, and the gate — beside the `@` popup's un-paged read, which it leaves
// alone.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PLS' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const newPage = (
  title: string,
  parent?: { kind: 'folder' | 'page'; id: string },
  projectId = fx.projectId,
) => pagesService.createPage(fx.ctx, { projectId, title, parent });

const archive = (id: string) =>
  adminDb.page.update({ where: { id }, data: { archivedAt: new Date(), archiveRootId: id } });

const pageOf = (q: string, cursor: string | null = null, ctx: ServiceContext = fx.ctx) =>
  pagesService.searchPagesForLink(ctx, { projectId: fx.projectId, q, cursor });

/** Stamp each page's `updatedAt` so the order is known, not left to insert timing. */
async function stamp(ids: string[], at: (i: number) => Date) {
  for (const [i, id] of ids.entries()) {
    await adminDb.page.update({ where: { id }, data: { updatedAt: at(i) } });
  }
}

async function browseOnlyReader(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'link-search-browse@example.com',
    password: 'hunter2hunter2',
    name: 'Browse only',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await setProjectRoleDefinitionFor(user.id, fx.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('pagesService.searchPagesForLink', () => {
  it('offers a cursor when one more match than the limit exists', async () => {
    for (let i = 0; i < PAGE_MENTION_SEARCH_LIMIT + 1; i++) await newPage(`Spec ${i}`);
    const page = await pageOf('spec');
    expect(page.items).toHaveLength(PAGE_MENTION_SEARCH_LIMIT);
    expect(page.nextCursor).not.toBeNull();
  });

  it('offers no cursor when the matches end exactly at the limit', async () => {
    for (let i = 0; i < PAGE_MENTION_SEARCH_LIMIT; i++) await newPage(`Spec ${i}`);
    const page = await pageOf('spec');
    expect(page.items).toHaveLength(PAGE_MENTION_SEARCH_LIMIT);
    expect(page.nextCursor).toBeNull();
  });

  it('visits every match once, newest edit first with id breaking ties, no page empty', async () => {
    const total = PAGE_MENTION_SEARCH_LIMIT * 3 - 2;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) ids.push((await newPage(`Roadmap ${i}`)).id);
    const tied = new Date('2026-01-01T00:00:00.000Z');
    // Two share one `updatedAt`, straddling a page boundary.
    await stamp(ids, (i) =>
      i === PAGE_MENTION_SEARCH_LIMIT - 1 || i === PAGE_MENTION_SEARCH_LIMIT
        ? tied
        : new Date(Date.UTC(2026, 0, 2, 0, 0, 0) + i * 60_000),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await pageOf('roadmap', cursor);
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(total);
    const expected = (
      await adminDb.page.findMany({
        where: { projectId: fx.projectId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((r) => r.id);
    expect(seen).toEqual(expected);
  });

  it("never offers an archived page or another project's page, and matches `%` literally", async () => {
    const live = await newPage('Roadmap live');
    await archive((await newPage('Roadmap archived')).id);
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    await newPage('Roadmap elsewhere', undefined, other.id);
    await newPage('100% done');
    await newPage('1000 done');

    expect((await pageOf('roadmap')).items.map((r) => r.id)).toEqual([live.id]);
    expect((await pageOf('0%')).items.map((r) => r.title)).toEqual(['100% done']);
  });

  it("carries each candidate's place", async () => {
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Specs' },
      fx.ctx,
    );
    const filed = await newPage('Roadmap Q4', { kind: 'folder', id: folder.id });
    const child = await newPage('Roadmap details', { kind: 'page', id: filed.id });
    const { items } = await pageOf('roadmap');
    expect(items.find((r) => r.id === filed.id)?.place).toEqual({
      folderPath: ['Specs'],
      parentPageTitle: null,
    });
    expect(items.find((r) => r.id === child.id)?.place).toEqual({
      folderPath: ['Specs'],
      parentPageTitle: 'Roadmap Q4',
    });
  });

  it('answers an empty page under the minimum query length', async () => {
    await newPage('Roadmap');
    expect(await pageOf('r')).toEqual({ items: [], nextCursor: null });
  });

  it('refuses a browser without page:view as edit', async () => {
    const reader = await browseOnlyReader();
    const err = await pageOf('ro', null, reader).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('edit');
  });

  it('refuses a cursor this module did not issue', async () => {
    await newPage('Roadmap');
    const bad = [
      'not base64 json',
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z'])).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z', ''])).toString('base64url'),
      Buffer.from(JSON.stringify(['not a date', 'id'])).toString('base64url'),
    ];
    for (const cursor of bad) {
      await expect(pageOf('roadmap', cursor)).rejects.toBeInstanceOf(PageLevelCursorInvalidError);
    }
    // A cursor it did issue is accepted.
    const ok = encodePageTitleSearchCursor({ updatedAt: new Date(), id: 'zzz' });
    await expect(pageOf('roadmap', ok)).resolves.toBeDefined();
  });
});
