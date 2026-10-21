import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { levelPageSize } from '@motir/pages';
import { db } from '@/lib/db';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { encodeWorkItemPagesCursor } from '@/lib/pages/workItemPagesCursor';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { toPageWorkItemLinkRowDto } from '@/lib/mappers/pageLinkMappers';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PageNotFoundError } from '@/lib/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// The page-side hand-link read on real Postgres (Story MOTIR-7567 · MOTIR-9198):
// `manual` rows only, one row per hand-linked item, newest link first, keyset
// paging, the archived-page branch, the unresolvable-item arm, `canLink` across
// roles, and the bound read under the workspace role the context sets.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PWI' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const newPage = (title: string) =>
  pagesService.createPage(fx.ctx, { projectId: fx.projectId, title });

let tick = 0;
const link = (
  pageId: string,
  workItemId: string,
  source: 'mention' | 'embed' | 'manual',
  createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)),
) =>
  adminDb.pageWorkItemLink.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      pageId,
      workItemId,
      source,
      createdById: fx.ownerId,
      createdAt,
    },
  });

const list = (
  pageId: string,
  opts: { ctx?: ServiceContext; cursor?: string | null; limit?: number | null } = {},
) =>
  pageLinksService.listWorkItemsForPage(opts.ctx ?? fx.ctx, {
    projectId: fx.projectId,
    pageId,
    cursor: opts.cursor,
    limit: opts.limit,
  });

async function reader(email: string, permissions: string[]): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({ ctx: fx.ctx, name: email, permissions });
  await setProjectRoleDefinitionFor(user.id, fx.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('pageLinksService.listWorkItemsForPage', () => {
  it('serves hand links only, one row per item, newest first, each with its chip summary', async () => {
    const page = await newPage('Notes');
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'Alpha' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'Beta' });
    const mentionOnly = await createTestWorkItem(fx, { kind: 'task', title: 'Gamma' });
    await link(page.id, a.id, 'manual');
    await link(page.id, b.id, 'manual');
    // Hand-linked AND mentioned: still ONE row, the read asks for `manual` only.
    await link(page.id, b.id, 'mention');
    await link(page.id, mentionOnly.id, 'mention');

    const dto = await list(page.id);
    expect(dto.rows.map((r) => r.workItemId)).toEqual([b.id, a.id]);
    expect(dto.nextCursor).toBeNull();
    expect(dto.rows[0]).toMatchObject({
      linkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      summary: { accessible: true, id: b.id, title: 'Beta', kind: 'task' },
    });
  });

  it('walks past one page without repeating or skipping a row', async () => {
    const page = await newPage('Big');
    const size = levelPageSize();
    const ids: string[] = [];
    for (let i = 0; i <= size; i++) {
      const w = await createTestWorkItem(fx, { kind: 'task', title: `T${i}` });
      ids.push(w.id);
      await link(page.id, w.id, 'manual');
    }
    const first = await list(page.id);
    expect(first.rows).toHaveLength(size);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(page.id, { cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.rows, ...second.rows].map((r) => r.workItemId);
    expect(new Set(seen).size).toBe(size + 1);
    expect(seen).toEqual([...ids].reverse());
  });

  it('clamps the limit to the tree level cap and serves its default when absent', async () => {
    const page = await newPage('Limits');
    const w = await createTestWorkItem(fx, { kind: 'task', title: 'One' });
    await link(page.id, w.id, 'manual');
    expect((await list(page.id, { limit: 1 })).rows).toHaveLength(1);
    expect((await list(page.id, { limit: 500 })).rows.length).toBeLessThanOrEqual(
      levelPageSize(500),
    );
  });

  it('refuses a foreign cursor, including the work item read’s two-element one', async () => {
    const page = await newPage('Cursors');
    await expect(list(page.id, { cursor: 'garbage' })).rejects.toBeInstanceOf(
      PageLevelCursorInvalidError,
    );
    const foreign = encodeWorkItemPagesCursor({ updatedAt: new Date(), id: 'x' });
    await expect(list(page.id, { cursor: foreign })).rejects.toBeInstanceOf(
      PageLevelCursorInvalidError,
    );
  });

  it('answers an archived page with an empty page, and the rows return on restore', async () => {
    const page = await newPage('Archived');
    const w = await createTestWorkItem(fx, { kind: 'task', title: 'Kept' });
    await link(page.id, w.id, 'manual');
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect(await list(page.id)).toEqual({ rows: [], nextCursor: null, canLink: false });
    await pagesService.restorePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    const back = await list(page.id);
    expect(back.rows.map((r) => r.workItemId)).toEqual([w.id]);
    expect(back.canLink).toBe(true);
  });

  it('shows an archived item as an accessible chip marked archived', async () => {
    const page = await newPage('Chips');
    const old = await createTestWorkItem(fx, { kind: 'task', title: 'Old' });
    await link(page.id, old.id, 'manual');
    await adminDb.workItem.update({ where: { id: old.id }, data: { archivedAt: new Date() } });
    const rows = (await list(page.id)).rows;
    expect(rows[0]?.summary).toMatchObject({ accessible: true, archived: true });
  });

  it('maps a link whose item resolves to nothing to a row with a null summary', () => {
    const row = toPageWorkItemLinkRowDto(
      { id: 'l1', workItemId: 'w1', createdAt: new Date('2026-01-01T00:00:00Z') },
      null,
    );
    expect(row).toEqual({ workItemId: 'w1', linkedAt: '2026-01-01T00:00:00.000Z', summary: null });
  });

  it('reports canLink by work_item:edit, with the rows still returned', async () => {
    const page = await newPage('Roles');
    const w = await createTestWorkItem(fx, { kind: 'task', title: 'W' });
    await link(page.id, w.id, 'manual');
    const viewer = await reader('viewer@example.com', [
      'project:browse',
      'work_item:view',
      'page:view',
    ]);
    const editor = await reader('editor@example.com', [
      'project:browse',
      'work_item:view',
      'work_item:edit',
      'page:view',
    ]);
    const asViewer = await list(page.id, { ctx: viewer });
    expect(asViewer.canLink).toBe(false);
    expect(asViewer.rows).toHaveLength(1);
    expect((await list(page.id, { ctx: editor })).canLink).toBe(true);
    // Edit rights show the control even over an empty strip.
    const empty = await newPage('Empty');
    expect(await list(empty.id, { ctx: editor })).toEqual({
      rows: [],
      nextCursor: null,
      canLink: true,
    });
  });

  it('refuses a reader without page:view as edit, naming no page', async () => {
    const page = await newPage('Secret page title');
    const r = await reader('nopages@example.com', ['project:browse', 'work_item:view']);
    const refused = await list(page.id, { ctx: r }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProjectAccessDeniedError);
    expect((refused as ProjectAccessDeniedError).kind).toBe('edit');
    expect(String((refused as Error).message)).not.toContain('Secret page title');
  });

  it('answers a page of another project, and an unknown page, as not found', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const foreign = await pagesService.createPage(fx.ctx, {
      projectId: other.id,
      title: 'Elsewhere',
    });
    await expect(list(foreign.id)).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(list('nope')).rejects.toBeInstanceOf(PageNotFoundError);
  });
});
