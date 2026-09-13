import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { FolderNotFoundError } from '@/lib/folders/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The FOLDER READS (Story MOTIR-5308 · MOTIR-5343) on a REAL Postgres, through
// the service under the ordinary workspace context:
//   · `listProjectFolders` — every folder of the project, none of a sibling's,
//     each with its name path, bounded with a truncation flag;
//   · `describeFolderDeletion` — the counts a delete confirmation shows, proven
//     equal to what `deleteFolder` then actually moves.

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

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

async function filedTask(fx: WorkItemFixture, title: string, folderId: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await foldersService.fileWorkItem(dto.id, { folderId }, fx.ctx);
  return dto.id;
}

async function memberWithRole(fx: WorkItemFixture, role: 'viewer' | 'member', email: string) {
  const user = await createTestUser({ email, name: role });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    projectMembershipRepository.create(
      { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: user.id, role },
      tx,
    ),
  );
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('listProjectFolders', () => {
  it('returns every folder of the project in tree order with its path, and none of a sibling project', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const archive = await folder(fx, 'Archive');
    const y2025 = await folder(fx, '2025', later.id);
    const q1 = await folder(fx, 'Q1', y2025.id);
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ctx.userId,
      name: 'Second project',
      identifier: 'SECND',
    });
    await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );

    const result = await foldersService.listProjectFolders({ projectId: fx.projectId }, fx.ctx);

    expect(result.truncated).toBe(false);
    expect(result.folders.map((f) => ({ id: f.id, path: f.path }))).toEqual([
      { id: later.id, path: ['Later'] },
      { id: y2025.id, path: ['Later', '2025'] },
      { id: q1.id, path: ['Later', '2025', 'Q1'] },
      { id: archive.id, path: ['Archive'] },
    ]);
    expect(result.folders[1]).toMatchObject({ parentFolderId: later.id, name: '2025' });
  });

  it('with the cap lowered, returns exactly `limit` folders, keeps every ancestor, and flags truncation', async () => {
    const fx = await makeWorkItemFixture();
    const a = await folder(fx, 'A');
    const b = await folder(fx, 'B');
    await folder(fx, 'A1', a.id);
    await folder(fx, 'B1', b.id);

    const result = await foldersService.listProjectFolders(
      { projectId: fx.projectId, limit: 3 },
      fx.ctx,
    );

    expect(result.truncated).toBe(true);
    expect(result.folders).toHaveLength(3);
    // Shallow levels are read first, so a truncated list never names a folder
    // whose parent it lost.
    const ids = new Set(result.folders.map((f) => f.id));
    for (const f of result.folders) {
      if (f.parentFolderId !== null) expect(ids.has(f.parentFolderId)).toBe(true);
    }

    const exact = await foldersService.listProjectFolders(
      { projectId: fx.projectId, limit: 4 },
      fx.ctx,
    );
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.folders).toHaveLength(4);
  });

  it('is open to a member who can browse, and closed to a non-member', async () => {
    const fx = await makeWorkItemFixture();
    await folder(fx, 'Later');
    const viewer = await memberWithRole(fx, 'viewer', 'reads-viewer@ex.com');
    const outsider = await createTestUser({ email: 'reads-outsider@ex.com', name: 'Outsider' });

    const seen = await foldersService.listProjectFolders({ projectId: fx.projectId }, viewer);
    expect(seen.folders.map((f) => f.name)).toEqual(['Later']);

    await expect(
      foldersService.listProjectFolders(
        { projectId: fx.projectId },
        { userId: outsider.id, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});

describe('describeFolderDeletion', () => {
  it('counts exactly what deleteFolder then moves — direct child folders and every filed item, archived included', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const doomed = await folder(fx, 'Doomed', later.id);
    await folder(fx, 'Child one', doomed.id);
    const childTwo = await folder(fx, 'Child two', doomed.id);
    // A grandchild folder travels with its parent and is NOT a direct child.
    await folder(fx, 'Grandchild', childTwo.id);
    await filedTask(fx, 'One', doomed.id);
    await filedTask(fx, 'Two', doomed.id);
    const archived = await filedTask(fx, 'Archived', doomed.id);
    await workItemsService.archiveWorkItem(archived, fx.ctx);

    const preview = await foldersService.describeFolderDeletion(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    expect(preview).toEqual({
      folderId: doomed.id,
      name: 'Doomed',
      childFolderCount: 2,
      workItemCount: 3,
      destination: { folderId: later.id, name: 'Later' },
    });

    const result = await foldersService.deleteFolder(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    expect(result.movedFolderIds).toHaveLength(preview.childFolderCount);
    expect(result.movedWorkItemIds).toHaveLength(preview.workItemCount);
    expect(result.destinationFolderId).toBe(preview.destination.folderId);
  });

  it('names the project root as a null destination, and an empty folder as zero and zero', async () => {
    const fx = await makeWorkItemFixture();
    const root = await folder(fx, 'Empty');

    await expect(
      foldersService.describeFolderDeletion({ projectId: fx.projectId, folderId: root.id }, fx.ctx),
    ).resolves.toEqual({
      folderId: root.id,
      name: 'Empty',
      childFolderCount: 0,
      workItemCount: 0,
      destination: { folderId: null, name: null },
    });
  });

  it('refuses a member without work_item:edit, and a folder addressed through another project', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const viewer = await memberWithRole(fx, 'viewer', 'reads-no-edit@ex.com');
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ctx.userId,
      name: 'Second project',
      identifier: 'SECND',
    });

    await expect(
      foldersService.describeFolderDeletion(
        { projectId: fx.projectId, folderId: later.id },
        viewer,
      ),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(
      foldersService.describeFolderDeletion({ projectId: other.id, folderId: later.id }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(
      foldersService.describeFolderDeletion(
        { projectId: fx.projectId, folderId: 'no-such-folder' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
  });
});
