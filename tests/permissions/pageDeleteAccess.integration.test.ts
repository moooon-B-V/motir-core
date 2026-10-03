import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { canDeletePages, canEditPages, type ProjectAccessInputs } from '@/lib/projects/access';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The `page:delete` KEY by role — MOTIR-7419 (Story MOTIR-5755,
// `docs/decisions/pages.md` §5). Permanently deleting an archived page is the
// Manager's alone; a Member archives and restores (`page:edit`) and cannot
// delete; a Viewer does neither. Proved three ways: the pure predicate, the
// throwing assertion, and the capability flag the page read carries.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const inputs = (workspaceRole: WorkspaceRole | null): ProjectAccessInputs => ({
  accessMode: 'workspace',
  workspaceRole,
  accessScope: workspaceRole === null ? null : 'full',
  addedToProject: false,
});

describe('canDeletePages — the pure predicate', () => {
  it('is true for a Manager and false for a Member, a Viewer and a non-member', () => {
    expect(canDeletePages(inputs('manager'))).toBe(true);
    expect(canDeletePages(inputs('member'))).toBe(false);
    expect(canDeletePages(inputs('viewer'))).toBe(false);
    expect(canDeletePages(inputs(null))).toBe(false);
  });

  it('a Member still edits pages — archive and restore stay on `page:edit`', () => {
    expect(canEditPages(inputs('member'))).toBe(true);
  });
});

interface Fixture {
  projectId: string;
  manager: ServiceContext;
  member: ServiceContext;
  viewer: ServiceContext;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `page-delete-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page delete ${tag}`,
  });
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'PDel', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'PDel',
    identifier: 'PDEL',
  });
  const as = async (tag: string, role: WorkspaceRole): Promise<ServiceContext> => {
    const user = await makeUser(tag);
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId, workspaceRole: role },
    });
    return { userId: user.id, workspaceId };
  };
  return {
    projectId: project.id,
    manager: { userId: owner.id, workspaceId },
    member: await as('member', 'member'),
    viewer: await as('viewer', 'viewer'),
  };
}

describe('projectAccessService — `page:delete` on real Postgres', () => {
  it('assertCanDeletePages admits a Manager and refuses a Member and a Viewer as `edit`', async () => {
    const f = await makeFixture();
    await expect(
      projectAccessService.assertCanDeletePages(f.projectId, f.manager),
    ).resolves.toBeUndefined();
    for (const ctx of [f.member, f.viewer]) {
      const err = await projectAccessService
        .assertCanDeletePages(f.projectId, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect(err).toMatchObject({ kind: 'edit' });
    }
  });

  it('getPageCapabilities returns canDeletePages true only for a Manager', async () => {
    const f = await makeFixture();
    expect(await projectAccessService.getPageCapabilities(f.projectId, f.manager)).toEqual({
      canViewPages: true,
      canEditPages: true,
      canDeletePages: true,
    });
    expect(await projectAccessService.getPageCapabilities(f.projectId, f.member)).toEqual({
      canViewPages: true,
      canEditPages: true,
      canDeletePages: false,
    });
    expect(await projectAccessService.getPageCapabilities(f.projectId, f.viewer)).toEqual({
      canViewPages: true,
      canEditPages: false,
      canDeletePages: false,
    });
  });
});
