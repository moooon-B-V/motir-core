import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createPage, pageStoreFor, savePageMarkdown, systemClock } from '@/lib/pages';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { syncBodyPageLinks } from '@/lib/workItems/bodyPageLinks';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Page tags in a work item's Description and Explanation write
// `page_work_item_link` rows (Story MOTIR-7694 · MOTIR-7696) — through the one
// service method every door calls, on real Postgres, in the save's transaction.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const inTenant = <T>(fn: Parameters<typeof withWorkspaceContext<T>>[1], projectId = fx.projectId) =>
  withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId }, fn);

const newPage = (projectId = fx.projectId) =>
  inTenant(
    (tx) =>
      createPage(pageStoreFor(tx), systemClock, {
        workspaceId: fx.workspaceId,
        projectId,
        actorId: fx.ownerId,
      }),
    projectId,
  );

const tag = (page: { id: string }, label = 'Page') => `[${label}](motir-page:${page.id})`;

const create = (fields: { descriptionMd?: string; explanationMd?: string }) =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Tagged', ...fields },
    fx.ctx,
  );

const linksOf = (workItemId: string) =>
  adminDb.pageWorkItemLink.findMany({
    where: { workItemId },
    orderBy: [{ source: 'asc' }, { createdAt: 'asc' }],
  });

const pairs = async (workItemId: string) =>
  (await linksOf(workItemId)).map((r) => [r.pageId, r.source]);

describe('workItemsService — page tags derive link rows', () => {
  it('a create with a tagged Description writes one row per page', async () => {
    const p = await newPage();
    const q = await newPage();
    const item = await create({
      descriptionMd: `See ${tag(p)}, ${tag(q)} and ${tag(p, 'again')}.`,
    });
    expect(await pairs(item.id)).toEqual([
      [p.id, 'description'],
      [q.id, 'description'],
    ]);
    const rows = await linksOf(item.id);
    expect(rows.every((r) => r.createdById === fx.ownerId)).toBe(true);
    expect(rows.every((r) => r.projectId === fx.projectId)).toBe(true);
  });

  it('an update adds and removes rows per field, leaving everything else alone', async () => {
    const p = await newPage();
    const q = await newPage();
    const item = await create({ descriptionMd: tag(p), explanationMd: tag(p) });
    // A `mention` row from P's own body and a `manual` row must survive.
    const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: p.id } });
    await inTenant((tx) =>
      savePageMarkdown(pageStoreFor(tx), systemClock, {
        pageId: p.id,
        actorId: fx.ownerId,
        markdown: `[K](motir:${item.id})`,
        expectedRevision: revision,
      }),
    );
    await adminDb.pageWorkItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId: q.id,
        workItemId: item.id,
        source: 'manual',
        createdById: fx.ownerId,
      },
    });
    const before = await linksOf(item.id);
    const firstExplanation = before.find((r) => r.source === 'explanation');

    await workItemsService.updateWorkItem(item.id, { descriptionMd: tag(q) }, fx.ctx);

    expect(await pairs(item.id)).toEqual([
      [p.id, 'mention'],
      [q.id, 'manual'],
      [q.id, 'description'],
      [p.id, 'explanation'],
    ]);
    // The untouched field's row is the same row, not a re-insert.
    const after = await linksOf(item.id);
    expect(after.find((r) => r.source === 'explanation')?.id).toBe(firstExplanation?.id);
  });

  it('an update that supplies only the Explanation keeps the Description rows', async () => {
    const p = await newPage();
    const item = await create({ descriptionMd: tag(p), explanationMd: tag(p) });
    await workItemsService.updateWorkItem(item.id, { explanationMd: 'No tag now.' }, fx.ctx);
    expect(await pairs(item.id)).toEqual([[p.id, 'description']]);
  });

  it('a page save never deletes an item-derived row', async () => {
    const p = await newPage();
    const item = await create({ descriptionMd: tag(p) });
    const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: p.id } });
    await inTenant((tx) =>
      savePageMarkdown(pageStoreFor(tx), systemClock, {
        pageId: p.id,
        actorId: fx.ownerId,
        markdown: 'A body naming nothing.',
        expectedRevision: revision,
      }),
    );
    expect(await pairs(item.id)).toEqual([[p.id, 'description']]);
  });

  it('skips a page of another project and an unknown id, and the save succeeds', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await newPage(other.id);
    const p = await newPage();
    const item = await create({
      descriptionMd: `${tag(foreign)} ${tag({ id: 'cmnosuchpage0000000000000' })} ${tag(p)}`,
    });
    expect(item.descriptionMd).toContain(`motir-page:${foreign.id}`);
    expect(await pairs(item.id)).toEqual([[p.id, 'description']]);
  });

  it('keeps the row of an archived page', async () => {
    const p = await newPage();
    await adminDb.page.update({
      where: { id: p.id },
      data: { archivedAt: new Date(), archiveRootId: p.id },
    });
    const item = await create({ descriptionMd: tag(p) });
    expect(await pairs(item.id)).toEqual([[p.id, 'description']]);
  });

  it('writes nothing when the save rolls back', async () => {
    const p = await newPage();
    const item = await create({});
    await expect(
      withWorkspaceContext(fx.ctx, async (tx) => {
        await syncBodyPageLinks(
          { id: item.id, workspaceId: fx.workspaceId, projectId: fx.projectId },
          { descriptionMd: tag(p) },
          fx.ownerId,
          tx,
        );
        throw new Error('the save failed');
      }),
    ).rejects.toThrow('the save failed');
    expect(await linksOf(item.id)).toEqual([]);
  });

  it('a supplied field with no tag and no row costs nothing', async () => {
    const item = await create({});
    const result = await withWorkspaceContext(fx.ctx, (tx) =>
      syncBodyPageLinks(
        { id: item.id, workspaceId: fx.workspaceId, projectId: fx.projectId },
        { descriptionMd: 'plain' },
        fx.ownerId,
        tx,
      ),
    );
    expect(result).toEqual({ deleted: 0, inserted: 0 });
    const none = await withWorkspaceContext(fx.ctx, (tx) =>
      syncBodyPageLinks(
        { id: item.id, workspaceId: fx.workspaceId, projectId: fx.projectId },
        {},
        fx.ownerId,
        tx,
      ),
    );
    expect(none).toEqual({ deleted: 0, inserted: 0 });
  });

  it('the Pages read lists the new sources beside the others', async () => {
    const p = await newPage();
    const item = await create({ descriptionMd: tag(p), explanationMd: tag(p) });
    const rows = await inTenant((tx) =>
      pageWorkItemLinkRepository.listPagesForWorkItem(item.id, null, 10, tx),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sources).toEqual(['description', 'explanation']);
  });
});
