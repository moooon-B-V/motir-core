import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { DEFAULT_BUG_FOLDER_NAME } from '@/lib/projects/bugDestination';
import { foldersService } from '@/lib/services/foldersService';
import { readOnboardingSubstrate } from '@/lib/services/onboardingSubstrateService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkspace } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The Bugs FOLDER seeded at project creation — Story MOTIR-4927 · Subtask
// MOTIR-4935. Every project is born with a root folder named Bugs and a bug
// destination pointing at it, in the SAME transaction as its workflow and
// board. The folder is a placement, not a work item (MOTIR-5296), so a new
// project still has nothing to plan, dispatch or report on.

async function workspaceWithOwner(tag: string) {
  const { workspace, owner } = await createTestWorkspace({ name: `Seed ${tag}` });
  return { workspace, owner, ctx: { userId: owner.id, workspaceId: workspace.id } };
}

async function foldersOf(projectId: string) {
  return adminDb.folder.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
}

async function destinationOf(projectId: string) {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
  return project.bugDestinationFolderId;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('createProject seeds the Bugs folder', () => {
  it('creates exactly one ROOT folder named Bugs, by the actor, and points the destination at it', async () => {
    const { workspace, owner } = await workspaceWithOwner('one');

    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Seeded',
      identifier: 'SEED',
    });

    const folders = await foldersOf(project.id);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      name: DEFAULT_BUG_FOLDER_NAME,
      parentFolderId: null,
      workspaceId: workspace.id,
      createdById: owner.id,
    });
    expect(await destinationOf(project.id)).toBe(folders[0]!.id);
  });

  it('leaves a new project with ZERO work items — nothing to count, dispatch or onboard from', async () => {
    const { workspace, owner, ctx } = await workspaceWithOwner('empty');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Still empty',
      identifier: 'EMPTY',
    });

    // The regression the first version of this story shipped: a seeded
    // work-item container made every one of these reads non-empty.
    expect(await adminDb.workItem.count({ where: { projectId: project.id } })).toBe(0);
    const substrate = await readOnboardingSubstrate(project.id, ctx);
    expect(substrate.itemCount).toBe(0);
    expect((await workItemsService.listReady(project.id, { limit: 100 }, ctx)).items).toEqual([]);
    expect((await workItemsService.countReady(project.id, {}, ctx)).count).toBe(0);
  });

  it('leaves NO orphan folder behind when an identifier collision retries the creation', async () => {
    const { workspace, owner } = await workspaceWithOwner('retry');

    const first = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Collide One',
      identifier: 'PRODE',
    });
    // Same identifier override: the first attempt inserts, seeds its folder,
    // hits the unique key, and rolls back; the retry re-suffixes and re-seeds.
    const second = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Collide Two',
      identifier: 'PRODE',
    });
    expect(second.identifier).not.toBe(first.identifier);

    // One folder per surviving project, and not one more in the workspace —
    // the rolled-back attempt's folder went with its project row.
    expect(await foldersOf(first.id)).toHaveLength(1);
    expect(await foldersOf(second.id)).toHaveLength(1);
    expect(await adminDb.folder.count({ where: { workspaceId: workspace.id } })).toBe(2);
    expect(await destinationOf(second.id)).toBe((await foldersOf(second.id))[0]!.id);
  });

  it('seeds the same way on the ensureDefaultProject path', async () => {
    const { workspace, owner } = await workspaceWithOwner('default');

    const project = await projectsService.ensureDefaultProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const destination = await destinationOf(project.id);
    expect(destination).not.toBeNull();
    const folder = await adminDb.folder.findUniqueOrThrow({ where: { id: destination! } });
    expect(folder).toMatchObject({ projectId: project.id, parentFolderId: null });
  });
});

describe('the name is a LABEL, not a lookup key', () => {
  it('keeps a renamed Bugs folder as the destination — the pointer is by id', async () => {
    const { workspace, owner, ctx } = await workspaceWithOwner('rename');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Renamer',
      identifier: 'RENAM',
    });
    const seeded = await destinationOf(project.id);

    await foldersService.renameFolder(
      { projectId: project.id, folderId: seeded!, name: 'Incoming defects' },
      ctx,
    );

    expect(await destinationOf(project.id)).toBe(seeded);
    const folder = await adminDb.folder.findUniqueOrThrow({ where: { id: seeded! } });
    expect(folder.name).toBe('Incoming defects');
  });
});
