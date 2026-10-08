import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService, PAGE_MENTION_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// The page tag's two reads on real Postgres (Story MOTIR-7694 · MOTIR-7697): the
// `@` picker's title search and the live chip summaries — their scope, the
// `page:view` gate, and the one unavailable answer for every cause.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PGM' });
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

const search = (q: string, ctx: ServiceContext = fx.ctx) =>
  pagesService.searchPagesForMention(ctx, { projectId: fx.projectId, q });

async function browseOnlyReader(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'browse-only@example.com',
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

describe('pagesService.searchPagesForMention', () => {
  it('returns live pages of the project whose title matches, with their place', async () => {
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Specs' },
      fx.ctx,
    );
    const filed = await newPage('Roadmap Q4', { kind: 'folder', id: folder.id });
    const child = await newPage('Roadmap details', { kind: 'page', id: filed.id });
    await newPage('Unrelated');
    const gone = await newPage('Roadmap old');
    await archive(gone.id);
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    await newPage('Roadmap elsewhere', undefined, other.id);

    const rows = await search('  roadMAP ');
    expect(rows.map((r) => r.id).sort()).toEqual([filed.id, child.id].sort());
    expect(rows.find((r) => r.id === filed.id)?.place).toEqual({
      folderPath: ['Specs'],
      parentPageTitle: null,
    });
    expect(rows.find((r) => r.id === child.id)?.place).toEqual({
      folderPath: ['Specs'],
      parentPageTitle: 'Roadmap Q4',
    });
  });

  it('matches `%` and `_` literally and caps the list', async () => {
    await newPage('100% done');
    await newPage('1000 done');
    expect((await search('0%')).map((r) => r.title)).toEqual(['100% done']);
    for (let i = 0; i < PAGE_MENTION_SEARCH_LIMIT + 2; i++) await newPage(`Spec ${i}`);
    expect(await search('spec')).toHaveLength(PAGE_MENTION_SEARCH_LIMIT);
  });

  it('answers [] under two characters', async () => {
    await newPage('Roadmap');
    expect(await search('r')).toEqual([]);
  });

  it('refuses a browser without page:view as edit', async () => {
    const reader = await browseOnlyReader();
    const err = await search('ro', reader).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('edit');
  });
});

describe('pagesService.resolvePageRefSummaries', () => {
  it('a live page is available with its CURRENT title; every other id is unavailable', async () => {
    const live = await newPage('Before rename');
    await pagesService.renamePage(fx.ctx, {
      projectId: fx.projectId,
      pageId: live.id,
      title: 'After rename',
    });
    const archived = await newPage('Archived secret');
    await archive(archived.id);
    const deleted = await newPage('Deleted secret');
    await adminDb.pageVersion.deleteMany({ where: { pageId: deleted.id } });
    await adminDb.page.delete({ where: { id: deleted.id } });
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await newPage('Foreign secret', undefined, other.id);

    const map = await pagesService.resolvePageRefSummaries(
      [live.id, archived.id, deleted.id, foreign.id, 'cmunknown', live.id],
      fx.projectId,
      fx.ctx,
    );
    expect(map).toEqual({
      [live.id]: { state: 'available', id: live.id, title: 'After rename' },
      [archived.id]: { state: 'unavailable', id: archived.id },
      [deleted.id]: { state: 'unavailable', id: deleted.id },
      [foreign.id]: { state: 'unavailable', id: foreign.id },
      cmunknown: { state: 'unavailable', id: 'cmunknown' },
    });
    expect(JSON.stringify(map)).not.toMatch(/secret/i);
  });

  it('a reader without page:view and a Visitor get unavailable for every id', async () => {
    const live = await newPage('Roadmap Q4');
    const reader = await browseOnlyReader();
    expect(await pagesService.resolvePageRefSummaries([live.id], fx.projectId, reader)).toEqual({
      [live.id]: { state: 'unavailable', id: live.id },
    });
    const visitor = { kind: 'visitor' } as unknown as VisitorReadContext;
    expect(await pagesService.resolvePageRefSummaries([live.id], fx.projectId, visitor)).toEqual({
      [live.id]: { state: 'unavailable', id: live.id },
    });
  });

  it('answers {} for a body that tags nothing', async () => {
    expect(await pagesService.resolvePageRefSummaries([], fx.projectId, fx.ctx)).toEqual({});
  });
});
