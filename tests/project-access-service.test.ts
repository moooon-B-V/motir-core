import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { canBrowse, canEdit } from '@/lib/projects/access';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ProjectAccessLevel } from '@prisma/client';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for the Story 6.4 · Subtask 6.4.3 access gate — the
// projectAccess browse/edit policy + its enforcement. Real Postgres, no DB
// mocks; the truncate helper CASCADE-resets workspace → project →
// project_membership between tests.
//
// The matrix under test (the AC's "each access level × role for both browse +
// edit, and the owner/admin bypass"):
//
//   role \ level           | open      | limited   | private
//   -----------------------+-----------+-----------+-----------
//   workspace owner        | view+edit | view+edit | view+edit   (always-pass)
//   workspace admin        | view+edit | view+edit | view+edit   (always-pass)
//   plain workspace member | view+edit | view only | no access
//   project viewer         | view only | view only | view only
//   project member         | view+edit | view+edit | view+edit
//   project admin          | view+edit | view+edit | view+edit
//   non-workspace member   | no access | no access | no access
//
// A browse denial → ProjectAccessDeniedError('browse') (route → 404, hidden);
// an edit denial on a browsable project → ('edit') (route → 403, read-only).

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

/** Resolve a rejection to the ProjectAccessDeniedError it threw (or fail). */
async function denial(p: Promise<unknown>): Promise<ProjectAccessDeniedError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProjectAccessDeniedError) return e;
    throw e;
  }
  throw new Error('expected ProjectAccessDeniedError but the call resolved');
}

interface Scenario {
  workspaceId: string;
  projectId: string;
  key: string;
  ownerCtx: WorkspaceContext;
  ctxs: {
    owner: WorkspaceContext;
    wsAdmin: WorkspaceContext;
    plainMember: WorkspaceContext;
    viewer: WorkspaceContext;
    member: WorkspaceContext;
    admin: WorkspaceContext;
    nonMember: WorkspaceContext;
  };
}

/**
 * Build a workspace + project at `level`, then attach one actor per role.
 * IMPORTANT ordering: the access level is set FIRST (going `private` auto-seeds
 * the THEN-current workspace members as project `member`s — at that point only
 * the owner exists), and every other actor is added AFTER, so each role is set
 * up cleanly (the workspace-admin + plain-member carry NO project membership).
 */
async function buildScenario(level: ProjectAccessLevel, slug: string): Promise<Scenario> {
  const owner = await makeUser(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);

  // Set the access level before adding the rest of the actors.
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level,
  });

  // Workspace admin — a pure workspace manager, NO project role.
  const wsAdmin = await makeUser(`wsadmin-${slug}@ex.com`, 'WsAdmin');
  await workspacesService.addMember({
    userId: wsAdmin.id,
    workspaceId: workspace.id,
    role: 'admin',
  });

  // Plain workspace member — NO project role.
  const plainMember = await makeUser(`plain-${slug}@ex.com`, 'Plain');
  await workspacesService.addMember({ userId: plainMember.id, workspaceId: workspace.id });

  // Three project-role actors — workspace members with an explicit project role.
  async function projectActor(name: string, role: 'viewer' | 'member' | 'admin') {
    const u = await makeUser(`${role}-${slug}@ex.com`, name);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return u;
  }
  const viewer = await projectActor('Viewer', 'viewer');
  const member = await projectActor('Member', 'member');
  const admin = await projectActor('Admin', 'admin');

  // A user in NEITHER the workspace nor the project.
  const nonMember = await makeUser(`outsider-${slug}@ex.com`, 'Outsider');

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    key: project.identifier,
    ownerCtx,
    ctxs: {
      owner: ownerCtx,
      wsAdmin: ctxFor(wsAdmin.id, workspace.id),
      plainMember: ctxFor(plainMember.id, workspace.id),
      viewer: ctxFor(viewer.id, workspace.id),
      member: ctxFor(member.id, workspace.id),
      admin: ctxFor(admin.id, workspace.id),
      nonMember: ctxFor(nonMember.id, workspace.id),
    },
  };
}

// The expected (browse, edit) verdict per role for each access level.
const EXPECTED: Record<
  ProjectAccessLevel,
  Record<keyof Scenario['ctxs'], { browse: boolean; edit: boolean }>
> = {
  open: {
    owner: { browse: true, edit: true },
    wsAdmin: { browse: true, edit: true },
    plainMember: { browse: true, edit: true },
    viewer: { browse: true, edit: false },
    member: { browse: true, edit: true },
    admin: { browse: true, edit: true },
    nonMember: { browse: false, edit: false },
  },
  limited: {
    owner: { browse: true, edit: true },
    wsAdmin: { browse: true, edit: true },
    plainMember: { browse: true, edit: false },
    viewer: { browse: true, edit: false },
    member: { browse: true, edit: true },
    admin: { browse: true, edit: true },
    nonMember: { browse: false, edit: false },
  },
  private: {
    owner: { browse: true, edit: true },
    wsAdmin: { browse: true, edit: true },
    plainMember: { browse: false, edit: false },
    viewer: { browse: true, edit: false },
    member: { browse: true, edit: true },
    admin: { browse: true, edit: true },
    nonMember: { browse: false, edit: false },
  },
};

const LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private'];
const ROLES = [
  'owner',
  'wsAdmin',
  'plainMember',
  'viewer',
  'member',
  'admin',
  'nonMember',
] as const;

describe('projectAccessService — browse/edit matrix (level × role)', () => {
  for (const level of LEVELS) {
    describe(`access level: ${level}`, () => {
      for (const role of ROLES) {
        const want = EXPECTED[level][role];
        it(`${role} → browse:${want.browse} edit:${want.edit}`, async () => {
          const s = await buildScenario(level, `${level}-${role}`);
          const ctx = s.ctxs[role];

          // getCapabilities — the non-throwing read the UI (6.4.6) consumes.
          const caps = await projectAccessService.getCapabilities(s.projectId, ctx);
          expect(caps).toEqual({ canBrowse: want.browse, canEdit: want.edit });

          // assertCanBrowse — resolves when allowed, throws 'browse' when not.
          if (want.browse) {
            await expect(
              projectAccessService.assertCanBrowse(s.projectId, ctx),
            ).resolves.toBeUndefined();
          } else {
            expect(
              (await denial(projectAccessService.assertCanBrowse(s.projectId, ctx))).kind,
            ).toBe('browse');
          }

          // assertCanEdit — resolves when allowed; otherwise 'browse' if they
          // can't even see it (hidden → 404), else 'edit' (read-only → 403).
          if (want.edit) {
            await expect(
              projectAccessService.assertCanEdit(s.projectId, ctx),
            ).resolves.toBeUndefined();
          } else {
            const err = await denial(projectAccessService.assertCanEdit(s.projectId, ctx));
            expect(err.kind).toBe(want.browse ? 'edit' : 'browse');
          }
        });
      }
    });
  }
});

describe('projectAccessService — resolution + leak safety', () => {
  it('throws ProjectNotFoundError for a project in another workspace (no existence leak)', async () => {
    const a = await buildScenario('open', 'leak-a');
    const b = await buildScenario('open', 'leak-b');
    // b's owner asks about a's project, scoped to b's workspace → not-found.
    await expect(
      projectAccessService.assertCanBrowse(a.projectId, b.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('canBrowse / canEdit — pure policy', () => {
  it('workspace owner/admin always pass regardless of level or project role', () => {
    for (const accessLevel of LEVELS) {
      for (const workspaceRole of ['owner', 'admin'] as const) {
        const inputs = { accessLevel, workspaceRole, projectRole: null };
        expect(canBrowse(inputs)).toBe(true);
        expect(canEdit(inputs)).toBe(true);
      }
    }
  });

  it('a project viewer can browse but never edit', () => {
    for (const accessLevel of LEVELS) {
      const inputs = {
        accessLevel,
        workspaceRole: 'member' as const,
        projectRole: 'viewer' as const,
      };
      expect(canBrowse(inputs)).toBe(true);
      expect(canEdit(inputs)).toBe(false);
    }
  });

  it('a non-workspace-member is denied at every level', () => {
    for (const accessLevel of LEVELS) {
      const inputs = { accessLevel, workspaceRole: null, projectRole: null };
      expect(canBrowse(inputs)).toBe(false);
      expect(canEdit(inputs)).toBe(false);
    }
  });
});

// Prove the gate is actually WIRED into representative read + write paths — not
// just callable in isolation (the AC's "no read or write path bypasses the gate").
describe('gate is threaded into read + write service paths', () => {
  it('getBoard (read) is denied to a non-member of a private project, allowed to the owner', async () => {
    const s = await buildScenario('private', 'board');
    await expect(boardsService.getBoard(s.projectId, s.ctxs.owner)).resolves.toBeTruthy();
    expect((await denial(boardsService.getBoard(s.projectId, s.ctxs.plainMember))).kind).toBe(
      'browse',
    );
  });

  it('createWorkItem (write) is denied to a viewer, allowed to a plain member on an open project', async () => {
    const s = await buildScenario('open', 'create');
    const created = await workItemsService.createWorkItem(
      { projectId: s.projectId, kind: 'task', title: 'By a member' },
      s.ctxs.plainMember,
    );
    expect(created.title).toBe('By a member');

    expect(
      (
        await denial(
          workItemsService.createWorkItem(
            { projectId: s.projectId, kind: 'task', title: 'By a viewer' },
            s.ctxs.viewer,
          ),
        )
      ).kind,
    ).toBe('edit');
  });
});
