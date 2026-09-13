import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { StaleWorkItemError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The quick view's FOLDER and filing's CONCURRENCY TOKEN (Story MOTIR-5308 ·
// MOTIR-5352), on a REAL Postgres through the real services:
//   · `getQuickView` carries `folderId` + the folder's name path, root first —
//     and reads no folder at all for an unfiled item (the payload is on every
//     row click);
//   · `fileWorkItem` returns the row's new `updatedAt`, which a following edit
//     can submit — while the token from before the filing is refused as stale.
// The token is exercised through `workItemsService.updateWorkItem`, the check
// `updateIssueAction` delegates to unchanged.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

function task(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

function peek(fx: WorkItemFixture, identifier: string) {
  return workItemsService.getQuickView(fx.projectId, identifier, 'open', fx.ctx, 'en');
}

describe('getQuickView — the item’s folder', () => {
  it('an unfiled item carries no folder, and reads none', async () => {
    const fx = await makeWorkItemFixture();
    const item = await task(fx, 'Loose');
    const pathRead = vi.spyOn(folderRepository, 'findPathNames');

    const view = await peek(fx, item.identifier);

    expect(view.folderId).toBeNull();
    expect(view.folderPath).toEqual([]);
    expect(pathRead).not.toHaveBeenCalled();
  });

  it('a filed item carries its folder id and the name path, root first', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const y2025 = await folder(fx, '2025', later.id);
    const q1 = await folder(fx, 'Q1', y2025.id);
    const atRoot = await task(fx, 'In a root folder');
    const deep = await task(fx, 'Two levels down');
    await foldersService.fileWorkItem(atRoot.id, { folderId: later.id }, fx.ctx);
    await foldersService.fileWorkItem(deep.id, { folderId: q1.id }, fx.ctx);

    await expect(peek(fx, atRoot.identifier)).resolves.toMatchObject({
      folderId: later.id,
      folderPath: ['Later'],
    });
    await expect(peek(fx, deep.identifier)).resolves.toMatchObject({
      folderId: q1.id,
      folderPath: ['Later', '2025', 'Q1'],
    });
  });
});

describe('fileWorkItem — the concurrency token', () => {
  it('returns the row’s new updatedAt, which the next edit may submit; the pre-filing token is stale', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const item = await task(fx, 'Tokened');
    const before = item.updatedAt;

    const filed = await foldersService.fileWorkItem(item.id, { folderId: later.id }, fx.ctx);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(filed.updatedAt).toBe(row.updatedAt.toISOString());
    expect(filed.updatedAt).not.toBe(before);

    await expect(
      workItemsService.updateWorkItem(item.id, { title: 'Stale edit' }, fx.ctx, {
        expectedUpdatedAt: before,
      }),
    ).rejects.toBeInstanceOf(StaleWorkItemError);

    await expect(
      workItemsService.updateWorkItem(item.id, { title: 'Fresh edit' }, fx.ctx, {
        expectedUpdatedAt: filed.updatedAt,
      }),
    ).resolves.toMatchObject({ title: 'Fresh edit' });
  });

  it('an unchanged filing still returns the row’s current token', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const item = await task(fx, 'Already there');
    const first = await foldersService.fileWorkItem(item.id, { folderId: later.id }, fx.ctx);

    const again = await foldersService.fileWorkItem(item.id, { folderId: later.id }, fx.ctx);

    expect(again.updatedAt).toBe(first.updatedAt);
  });
});
