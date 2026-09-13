import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { foldersService } from '@/lib/services/foldersService';
import {
  CrossProjectFolderError,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
} from '@/lib/folders/errors';
import { toFolderPickerNodeDtos } from '@/lib/mappers/folderMappers';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The folder layer's EDGES (Story MOTIR-5308 · MOTIR-5317, the story's vitest
// gate), on a REAL Postgres: what the repository does when a write reaches the
// database without the service's friendly pre-checks — the race backstops — and
// the two pure arms the service paths never take.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('folderRepository — the write backstops', () => {
  it('a duplicate sibling name that reaches the unique index is FolderNameTakenError, naming it', async () => {
    const fx = await makeWorkItemFixture();
    await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Later' },
      fx.ctx,
    );

    await expect(
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        folderRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            parentFolderId: null,
            name: 'LATER',
            position: 'z0',
            createdById: fx.ctx.userId,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_NAME_TAKEN', folderName: 'LATER' });
  });

  it('deleting a folder that is already gone is FolderNotFoundError', async () => {
    const fx = await makeWorkItemFixture();

    await expect(
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        folderRepository.delete('no-such-folder', tx),
      ),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
  });

  it('an unrelated database refusal is rethrown as it is, not dressed as a folder error', async () => {
    const fx = await makeWorkItemFixture();

    const refusal = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      folderRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: 'no-such-project',
          parentFolderId: null,
          name: 'Orphan',
          position: 'a0',
          createdById: fx.ctx.userId,
        },
        tx,
      ),
    ).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(Error);
    for (const typed of [
      FolderNameTakenError,
      FolderNotFoundError,
      CrossProjectFolderError,
      FolderCycleError,
    ]) {
      expect(refusal).not.toBeInstanceOf(typed);
    }
  });

  it('a move that lands beside a same-named sibling is FolderNameTakenError, with no name to hand', async () => {
    const fx = await makeWorkItemFixture();
    const later = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Later' },
      fx.ctx,
    );
    // Legal where it is — a different parent — and a clash at the root.
    const nested = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: later.id, name: 'LATER' },
      fx.ctx,
    );

    const refusal = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      folderRepository.move(nested.id, { parentFolderId: null, position: 'z0' }, tx),
    ).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(FolderNameTakenError);
    expect(refusal).toMatchObject({ folderName: null });
  });

  it('reading no ids reads nothing, and reading ids reads exactly those folders', async () => {
    const fx = await makeWorkItemFixture();
    const make = (name: string) =>
      foldersService.createFolder({ projectId: fx.projectId, parentFolderId: null, name }, fx.ctx);
    const a = await make('A');
    await make('B');
    const c = await make('C');

    await expect(
      withWorkspaceServiceContext(fx.workspaceId, (tx) => folderRepository.findByIds([], tx)),
    ).resolves.toEqual([]);
    const read = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      folderRepository.findByIds([a.id, c.id], tx),
    );
    expect(read.map((f) => f.id).sort()).toEqual([a.id, c.id].sort());
  });

  it('an error that is not from the database at all — its cause carrying no message — is rethrown untouched', async () => {
    // No database path produces this: every folder trigger raises a FOLDER_*
    // code, and Prisma's own refusals are known request errors. It pins the
    // translator's last arm, so a non-database failure is never dressed up as
    // a folder refusal.
    const boom = Object.assign(new Error('socket closed'), { cause: { code: 'ECONNRESET' } });
    const tx = {
      folder: {
        create: async () => {
          throw boom;
        },
      },
    } as unknown as Parameters<typeof folderRepository.create>[1];

    await expect(
      folderRepository.create(
        {
          workspaceId: 'w',
          projectId: 'p',
          parentFolderId: null,
          name: 'Any',
          position: 'a0',
          createdById: 'u',
        },
        tx,
      ),
    ).rejects.toBe(boom);
  });
});

describe('the pure arms', () => {
  it('a name clash caught by the index during a race, with no name to hand, still reads as a sentence', () => {
    const err = new FolderNameTakenError(null);
    expect(err.message).toBe('A folder with that name is already here.');
    expect(err.code).toBe('FOLDER_NAME_TAKEN');
  });

  it('a folder whose parent is not in the read is still listed, at the end, under its own name', () => {
    const nodes = toFolderPickerNodeDtos([
      { id: 'later', parentFolderId: null, name: 'Later', position: 'a0' },
      { id: 'lost', parentFolderId: 'cut-off-by-the-limit', name: 'Lost', position: 'a0' },
      { id: 'y2025', parentFolderId: 'later', name: '2025', position: 'a0' },
    ]);

    expect(nodes.map((n) => [n.id, n.path])).toEqual([
      ['later', ['Later']],
      ['y2025', ['Later', '2025']],
      ['lost', ['Lost']],
    ]);
  });
});
